// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// HEXSEAL — ServiceBoardFacet.sol
// Маркетплейс услуг: исполнитель публикует → клиент запрашивает →
//                   исполнитель принимает/отклоняет → Agreement
//
// Симметричный двусторонний флоу:
//   mintService():    executor платит fee → feeRecipient (антиспам)
//   requestService(): client НЕ платит fee (уже уплачен исполнителем при mintService)
//                     client amount → хранится в Diamond
//   acceptRequest():  executor принимает → amount Diamond → Agreement
//   rejectRequest():  executor отклоняет → amount рефанд client
//   cancelRequest():  client отменяет (пока PENDING) → amount рефанд
// ============================================================

import "../FactoryFacet.sol";
import "../DiamondProxy.sol";
import "./IFactory.sol";

// ---------- STORAGE ----------

library ServiceBoardStorage {
    bytes32 constant POSITION = keccak256("hexseal.serviceboard.storage");

    enum ServiceStatus { ACTIVE, PAUSED, REMOVED }
    enum RequestStatus { PENDING, ACCEPTED, REJECTED, CANCELLED, SUPERSEDED }

    struct Service {
        address executor;
        string title;           // max 100 chars
        string description;     // max 500 chars
        uint256 price;          // рекомендованная цена USDC (6 decimals)
        uint256 deadlineDays;
        uint8 region;
        ServiceStatus status;
        uint256 createdAt;
        uint256 hiresCount;     // сколько раз приняли запрос
    }

    struct HireRequest {
        address client;
        uint256 serviceId;
        uint256 amount;         // сумма сделки (client заблокировал в Diamond)
        uint256 deadlineDays;
        string  terms;
        uint8 region;
        RequestStatus status;
        uint256 createdAt;
        address agreement;      // адрес Agreement после acceptRequest
    }

    struct Layout {
        // Services
        uint256 nextServiceId;
        mapping(uint256 => Service) services;
        mapping(address => uint256[]) executorServices;
        mapping(uint256 => address[]) serviceClients;   // устаревший, теперь через requests

        // HireRequests (добавлены в этом апгрейде, слоты 4-8)
        uint256 nextRequestId;
        mapping(uint256 => HireRequest) requests;
        mapping(uint256 => uint256[]) serviceRequests;  // serviceId → requestIds
        mapping(address => uint256[]) clientRequests;   // client → requestIds
        mapping(uint256 => uint256) requestFunds;       // requestId → USDC locked in Diamond

        // Bounded list of currently-PENDING request IDs per (client, executor) pair —
        // NOT a full history (that only ever grows). Used by acceptRequest() to find
        // and auto-refund sibling requests that can never be accepted once one from
        // this pair is accepted (hasActivePair blocks them forever after).
        mapping(address => mapping(address => uint256[])) pendingRequestIdsByClientAndExecutor;
    }

    function store() internal pure returns (Layout storage s) {
        bytes32 p = POSITION;
        assembly { s.slot := p }
    }
}

// USDC permit interface (EIP-2612)
interface IServiceBoardUSDC {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

// ---------- FACET ----------

contract ServiceBoardFacet {

    // -------- EVENTS --------

    event ServicePosted(uint256 indexed serviceId, address indexed executor, uint256 price, uint8 region, string title, string description, uint256 deadlineDays);
    event ServiceRemoved(uint256 indexed serviceId, address indexed executor);
    event ServicePaused(uint256 indexed serviceId);
    event ServiceUnpaused(uint256 indexed serviceId);
    event ServiceEdited(uint256 indexed serviceId, address indexed executor, string title, string description, uint256 price, uint256 deadlineDays, uint8 region);
    event ServiceRequested(uint256 indexed requestId, uint256 indexed serviceId, address indexed client, uint256 amount);
    event RequestAccepted(uint256 indexed requestId, address indexed executor, address indexed client, address agreement);
    event RequestRejected(uint256 indexed requestId, address indexed executor, address indexed client);
    event RequestCancelled(uint256 indexed requestId, address indexed client);
    event RequestSuperseded(uint256 indexed requestId, address indexed client, address indexed executor, uint256 refundAmount);

    // -------- ERRORS --------

    error TitleInvalid();
    error DescriptionTooLong();
    error ZeroAmount();
    error DeadlineInvalid();
    error InvalidRegion();
    error ZeroFee();
    error NotExecutor();
    error NotClient();
    error ServiceNotActive();
    error RequestNotPending();
    error Reentrant();
    error FactoryPaused();
    error SelfRequest();
    error ActiveDealExists();

    // -------- REENTRANCY --------

    modifier nonReentrant() {
        if (DiamondGuard.status() == DiamondGuard.ENTERED) revert Reentrant();
        DiamondGuard.setStatus(DiamondGuard.ENTERED);
        _;
        DiamondGuard.setStatus(DiamondGuard.NOT_ENTERED);
    }

    modifier whenNotPaused() {
        if (FactoryStorage.store().paused) revert FactoryPaused();
        _;
    }

    // -------- ERC-2771 msgSender --------

    function _msgSender() internal view returns (address sender) {
        if (
            msg.sender == FactoryStorage.store().trustedForwarder &&
            msg.data.length >= 20
        ) {
            assembly {
                sender := shr(96, calldataload(sub(calldatasize(), 20)))
            }
        } else {
            sender = msg.sender;
        }
    }

    // -------- EXECUTOR: POST SERVICE --------

    /// @notice Исполнитель публикует услугу — gasless-совместим (ERC-2771).
    /// @dev Для gasless-пути relay вызывает USDC.permit() отдельно перед ForwardRequest.
    ///      Для прямого пути требует approve(diamond, fee) до вызова.
    function mintService(
        string memory title,
        string memory description,
        uint256 price,
        uint256 deadlineDays,
        uint8 region
    ) external nonReentrant whenNotPaused returns (uint256 serviceId) {
        address executor = _msgSender();

        uint256 titleLen = bytes(title).length;
        if (titleLen == 0 || titleLen > 100) revert TitleInvalid();
        if (bytes(description).length > 500) revert DescriptionTooLong();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 6) revert InvalidRegion();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        uint256 fee = fs.regionFee[region];
        if (fee == 0) revert ZeroFee();

        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        serviceId = s.nextServiceId++;

        s.services[serviceId] = ServiceBoardStorage.Service({
            executor:    executor,
            title:       title,
            description: description,
            price:       price,
            deadlineDays: deadlineDays,
            region:      region,
            status:      ServiceBoardStorage.ServiceStatus.ACTIVE,
            createdAt:   block.timestamp,
            hiresCount:  0
        });
        s.executorServices[executor].push(serviceId);

        // Антиспам fee → feeRecipient (не возвращается)
        _safeTransferFrom(fs.usdc, executor, fs.feeRecipient, fee);

        emit ServicePosted(serviceId, executor, price, region, title, description, deadlineDays);
    }

    /// @notice Gasless-вариант mintService с EIP-2612 permit (один вызов без предварительного approve).
    /// @dev executor передаётся явно — msg.sender здесь форвардер (ERC-2771).
    function mintServiceWithPermit(
        address executor,
        string memory title,
        string memory description,
        uint256 price,
        uint256 deadlineDays,
        uint8 region,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256 serviceId) {
        uint256 titleLen = bytes(title).length;
        if (titleLen == 0 || titleLen > 100) revert TitleInvalid();
        if (bytes(description).length > 500) revert DescriptionTooLong();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 6) revert InvalidRegion();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        uint256 fee = fs.regionFee[region];
        if (fee == 0) revert ZeroFee();

        IServiceBoardUSDC(fs.usdc).permit(executor, address(this), fee, permitDeadline, v, r, s);

        ServiceBoardStorage.Layout storage sbl = ServiceBoardStorage.store();
        serviceId = sbl.nextServiceId++;

        sbl.services[serviceId] = ServiceBoardStorage.Service({
            executor:    executor,
            title:       title,
            description: description,
            price:       price,
            deadlineDays: deadlineDays,
            region:      region,
            status:      ServiceBoardStorage.ServiceStatus.ACTIVE,
            createdAt:   block.timestamp,
            hiresCount:  0
        });
        sbl.executorServices[executor].push(serviceId);

        _safeTransferFrom(fs.usdc, executor, fs.feeRecipient, fee);

        emit ServicePosted(serviceId, executor, price, region, title, description, deadlineDays);
    }

    function removeService(uint256 serviceId) external {
        address sender = _msgSender();
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.Service storage svc = s.services[serviceId];

        if (sender != svc.executor) revert NotExecutor();
        if (svc.status == ServiceBoardStorage.ServiceStatus.REMOVED) revert ServiceNotActive();

        svc.status = ServiceBoardStorage.ServiceStatus.REMOVED;
        emit ServiceRemoved(serviceId, sender);
    }

    function pauseService(uint256 serviceId) external {
        address sender = _msgSender();
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.Service storage svc = s.services[serviceId];

        if (sender != svc.executor) revert NotExecutor();
        if (svc.status != ServiceBoardStorage.ServiceStatus.ACTIVE) revert ServiceNotActive();

        svc.status = ServiceBoardStorage.ServiceStatus.PAUSED;
        emit ServicePaused(serviceId);
    }

    function unpauseService(uint256 serviceId) external {
        address sender = _msgSender();
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.Service storage svc = s.services[serviceId];

        if (sender != svc.executor) revert NotExecutor();
        if (svc.status != ServiceBoardStorage.ServiceStatus.PAUSED) revert ServiceNotActive();

        svc.status = ServiceBoardStorage.ServiceStatus.ACTIVE;
        emit ServiceUnpaused(serviceId);
    }

    /// @notice Исполнитель редактирует услугу (gasless-совместим).
    /// @dev Разрешено для ACTIVE и PAUSED услуг (не для REMOVED).
    ///      Безопасно даже при наличии PENDING-запросов: каждый запрос фиксирует
    ///      свои условия (amount/deadline) независимо от полей услуги.
    function editService(
        uint256 serviceId,
        string memory title,
        string memory description,
        uint256 price,
        uint256 deadlineDays,
        uint8 region
    ) external whenNotPaused {
        address sender = _msgSender();
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.Service storage svc = s.services[serviceId];

        if (sender != svc.executor) revert NotExecutor();
        if (svc.status == ServiceBoardStorage.ServiceStatus.REMOVED) revert ServiceNotActive();

        // --- Валидация (та же что при минте) ---
        uint256 titleLen = bytes(title).length;
        if (titleLen == 0 || titleLen > 100) revert TitleInvalid();
        if (bytes(description).length > 500) revert DescriptionTooLong();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 6) revert InvalidRegion();

        // --- Effects ---
        svc.title        = title;
        svc.description  = description;
        svc.price        = price;
        svc.deadlineDays = deadlineDays;
        svc.region       = region;

        emit ServiceEdited(serviceId, sender, title, description, price, deadlineDays, region);
    }

    // -------- CLIENT: REQUEST SERVICE --------

    /// @notice Клиент запрашивает найм — gasless-совместим (ERC-2771).
    /// @dev Для gasless-пути relay вызывает USDC.permit() отдельно перед ForwardRequest.
    ///      Для прямого пути требует approve(diamond, amount) до вызова.
    ///      PPP fee уже уплачен исполнителем при mintService — здесь только amount.
    function requestService(
        uint256 serviceId,
        uint256 amount,
        uint256 deadlineDays,
        string  calldata terms,
        uint8 region
    ) external nonReentrant whenNotPaused returns (uint256 requestId) {
        address client = _msgSender();

        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 6) revert InvalidRegion();

        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.Service storage svc = s.services[serviceId];

        if (svc.status != ServiceBoardStorage.ServiceStatus.ACTIVE) revert ServiceNotActive();
        if (client == svc.executor) revert SelfRequest();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        if (IRegistry(fs.diamond).hasActivePair(client, svc.executor)) revert ActiveDealExists();

        requestId = s.nextRequestId++;

        s.requests[requestId] = ServiceBoardStorage.HireRequest({
            client:       client,
            serviceId:    serviceId,
            amount:       amount,
            deadlineDays: deadlineDays,
            terms:        terms,
            region:       region,
            status:       ServiceBoardStorage.RequestStatus.PENDING,
            createdAt:    block.timestamp,
            agreement:    address(0)
        });
        s.serviceRequests[serviceId].push(requestId);
        s.clientRequests[client].push(requestId);
        s.pendingRequestIdsByClientAndExecutor[client][svc.executor].push(requestId);

        // Amount → Diamond (вернётся при reject/cancel или уйдёт в Agreement при accept)
        _safeTransferFrom(fs.usdc, client, address(this), amount);
        s.requestFunds[requestId] = amount;

        emit ServiceRequested(requestId, serviceId, client, amount);
    }

    /// @notice Gasless-вариант requestService с EIP-2612 permit.
    /// @dev client передаётся явно — msg.sender здесь форвардер (ERC-2771).
    function requestServiceWithPermit(
        address client,
        uint256 serviceId,
        uint256 amount,
        uint256 deadlineDays,
        string  calldata terms,
        uint8   region,
        uint256 permitDeadline,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (uint256 requestId) {
        if (amount == 0) revert ZeroAmount();
        if (deadlineDays == 0 || deadlineDays > 365) revert DeadlineInvalid();
        if (region > 6) revert InvalidRegion();

        ServiceBoardStorage.Layout storage st = ServiceBoardStorage.store();
        ServiceBoardStorage.Service storage svc = st.services[serviceId];

        if (svc.status != ServiceBoardStorage.ServiceStatus.ACTIVE) revert ServiceNotActive();
        if (client == svc.executor) revert SelfRequest();

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        if (IRegistry(fs.diamond).hasActivePair(client, svc.executor)) revert ActiveDealExists();

        IServiceBoardUSDC(fs.usdc).permit(client, address(this), amount, permitDeadline, v, r, s);

        requestId = st.nextRequestId++;

        st.requests[requestId] = ServiceBoardStorage.HireRequest({
            client:       client,
            serviceId:    serviceId,
            amount:       amount,
            deadlineDays: deadlineDays,
            terms:        terms,
            region:       region,
            status:       ServiceBoardStorage.RequestStatus.PENDING,
            createdAt:    block.timestamp,
            agreement:    address(0)
        });
        st.serviceRequests[serviceId].push(requestId);
        st.clientRequests[client].push(requestId);
        st.pendingRequestIdsByClientAndExecutor[client][svc.executor].push(requestId);

        _safeTransferFrom(fs.usdc, client, address(this), amount);
        st.requestFunds[requestId] = amount;

        emit ServiceRequested(requestId, serviceId, client, amount);
    }

    // -------- EXECUTOR: ACCEPT / REJECT --------

    /// @notice Исполнитель принимает запрос → деплоит Agreement, переводит amount из Diamond.
    function acceptRequest(uint256 requestId)
        external nonReentrant whenNotPaused returns (address agreementAddr)
    {
        address sender = _msgSender();
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.HireRequest storage req = s.requests[requestId];
        ServiceBoardStorage.Service storage svc = s.services[req.serviceId];

        if (sender != svc.executor) revert NotExecutor();
        if (req.status != ServiceBoardStorage.RequestStatus.PENDING) revert RequestNotPending();

        // Effects first
        req.status = ServiceBoardStorage.RequestStatus.ACCEPTED;
        svc.hiresCount++;

        uint256 held = s.requestFunds[requestId];
        s.requestFunds[requestId] = 0;

        address client   = req.client;
        uint256 amount   = req.amount;
        uint256 deadline = req.deadlineDays;
        string memory terms = req.terms;
        uint8   region   = req.region;

        // Deploy Agreement через Factory
        (bool ok, bytes memory ret) = address(this).call(
            abi.encodeWithSelector(
                IFactory.deployAgreement.selector,
                client,
                sender,
                address(0),
                amount,
                deadline,
                terms,
                region
            )
        );
        require(ok, "ServiceBoard: deploy failed");
        agreementAddr = abi.decode(ret, (address));

        req.agreement = agreementAddr;

        // Amount из Diamond → Agreement
        FactoryStorage.Layout storage fs = FactoryStorage.store();
        _safeTransfer(fs.usdc, agreementAddr, held);

        // Активируем Agreement
        (bool funded, ) = agreementAddr.call(abi.encodeWithSignature("fundFromFactory()"));
        require(funded, "ServiceBoard: fund failed");

        emit RequestAccepted(requestId, sender, client, agreementAddr);

        // Any other PENDING request from this same client to this same executor can
        // never be accepted now (hasActivePair blocks it) — refund and mark it
        // SUPERSEDED so it doesn't sit stuck forever.
        uint256[] storage siblings = s.pendingRequestIdsByClientAndExecutor[client][sender];
        for (uint256 i = 0; i < siblings.length; i++) {
            uint256 siblingId = siblings[i];
            if (siblingId == requestId) continue;
            ServiceBoardStorage.HireRequest storage siblingReq = s.requests[siblingId];
            if (siblingReq.status != ServiceBoardStorage.RequestStatus.PENDING) continue;
            siblingReq.status = ServiceBoardStorage.RequestStatus.SUPERSEDED;
            uint256 siblingRefund = s.requestFunds[siblingId];
            s.requestFunds[siblingId] = 0;
            _safeTransfer(fs.usdc, client, siblingRefund);
            emit RequestSuperseded(siblingId, client, sender, siblingRefund);
        }
        delete s.pendingRequestIdsByClientAndExecutor[client][sender];
    }

    /// @notice Исполнитель отклоняет запрос → amount рефандится клиенту.
    function rejectRequest(uint256 requestId) external nonReentrant {
        address sender = _msgSender();
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.HireRequest storage req = s.requests[requestId];
        ServiceBoardStorage.Service storage svc = s.services[req.serviceId];

        if (sender != svc.executor) revert NotExecutor();
        if (req.status != ServiceBoardStorage.RequestStatus.PENDING) revert RequestNotPending();

        req.status = ServiceBoardStorage.RequestStatus.REJECTED;
        _removePendingPair(req.client, svc.executor, requestId);
        uint256 refund = s.requestFunds[requestId];
        s.requestFunds[requestId] = 0;

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        _safeTransfer(fs.usdc, req.client, refund);

        emit RequestRejected(requestId, sender, req.client);
    }

    // -------- CLIENT: CANCEL --------

    /// @notice Клиент отменяет запрос пока он PENDING → amount рефандится.
    function cancelRequest(uint256 requestId) external nonReentrant {
        address sender = _msgSender();
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        ServiceBoardStorage.HireRequest storage req = s.requests[requestId];
        ServiceBoardStorage.Service storage svc = s.services[req.serviceId];

        if (sender != req.client) revert NotClient();
        if (req.status != ServiceBoardStorage.RequestStatus.PENDING) revert RequestNotPending();

        req.status = ServiceBoardStorage.RequestStatus.CANCELLED;
        _removePendingPair(req.client, svc.executor, requestId);
        uint256 refund = s.requestFunds[requestId];
        s.requestFunds[requestId] = 0;

        FactoryStorage.Layout storage fs = FactoryStorage.store();
        _safeTransfer(fs.usdc, sender, refund);

        emit RequestCancelled(requestId, sender);
    }

    // -------- VIEW --------

    function getService(uint256 serviceId) external view returns (ServiceBoardStorage.Service memory) {
        return ServiceBoardStorage.store().services[serviceId];
    }

    function getExecutorServices(address executor) external view returns (uint256[] memory) {
        return ServiceBoardStorage.store().executorServices[executor];
    }

    function getServiceClients(uint256 serviceId) external view returns (address[] memory) {
        return ServiceBoardStorage.store().serviceClients[serviceId];
    }

    function totalServices() external view returns (uint256) {
        return ServiceBoardStorage.store().nextServiceId;
    }

    function getRequest(uint256 requestId) external view returns (ServiceBoardStorage.HireRequest memory) {
        return ServiceBoardStorage.store().requests[requestId];
    }

    function getServiceRequests(uint256 serviceId) external view returns (uint256[] memory) {
        return ServiceBoardStorage.store().serviceRequests[serviceId];
    }

    function getClientRequests(address client) external view returns (uint256[] memory) {
        return ServiceBoardStorage.store().clientRequests[client];
    }

    function totalRequests() external view returns (uint256) {
        return ServiceBoardStorage.store().nextRequestId;
    }

    function getRequestFunds(uint256 requestId) external view returns (uint256) {
        return ServiceBoardStorage.store().requestFunds[requestId];
    }

    function getPendingRequestIdsByClientAndExecutor(address clientAddr, address executorAddr) external view returns (uint256[] memory) {
        return ServiceBoardStorage.store().pendingRequestIdsByClientAndExecutor[clientAddr][executorAddr];
    }

    /// @notice Все активные услуги с их ID
    function getActiveServices() external view returns (
        uint256[] memory ids,
        ServiceBoardStorage.Service[] memory activeServices
    ) {
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        uint256 total = s.nextServiceId;

        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) {
            if (s.services[i].status == ServiceBoardStorage.ServiceStatus.ACTIVE) count++;
        }

        ids = new uint256[](count);
        activeServices = new ServiceBoardStorage.Service[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; i++) {
            if (s.services[i].status == ServiceBoardStorage.ServiceStatus.ACTIVE) {
                ids[idx] = i;
                activeServices[idx] = s.services[i];
                idx++;
            }
        }
    }

    /// @notice Ожидающие (PENDING) запросы на услугу
    function getPendingRequests(uint256 serviceId) external view returns (
        uint256[] memory ids,
        ServiceBoardStorage.HireRequest[] memory pendingReqs
    ) {
        ServiceBoardStorage.Layout storage s = ServiceBoardStorage.store();
        uint256[] storage reqIds = s.serviceRequests[serviceId];
        uint256 count = 0;
        for (uint256 i = 0; i < reqIds.length; i++) {
            if (s.requests[reqIds[i]].status == ServiceBoardStorage.RequestStatus.PENDING) count++;
        }
        ids = new uint256[](count);
        pendingReqs = new ServiceBoardStorage.HireRequest[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < reqIds.length; i++) {
            if (s.requests[reqIds[i]].status == ServiceBoardStorage.RequestStatus.PENDING) {
                ids[idx] = reqIds[i];
                pendingReqs[idx] = s.requests[reqIds[i]];
                idx++;
            }
        }
    }

    // -------- INTERNAL --------

    function _removePendingPair(address clientAddr, address executorAddr, uint256 requestId) internal {
        uint256[] storage list = ServiceBoardStorage.store().pendingRequestIdsByClientAndExecutor[clientAddr][executorAddr];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == requestId) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "ServiceBoard: transferFrom failed");
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "ServiceBoard: transfer failed");
    }
}
