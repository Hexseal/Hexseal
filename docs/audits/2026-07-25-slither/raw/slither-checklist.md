**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [arbitrary-send-eth](#arbitrary-send-eth) (1 results) (High)
 - [encode-packed-collision](#encode-packed-collision) (4 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (5 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (4 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (7 results) (Medium)
 - [unused-return](#unused-return) (4 results) (Medium)
 - [missing-zero-check](#missing-zero-check) (6 results) (Low)
 - [reentrancy-benign](#reentrancy-benign) (7 results) (Low)
 - [reentrancy-events](#reentrancy-events) (15 results) (Low)
 - [return-bomb](#return-bomb) (1 results) (Low)
 - [timestamp](#timestamp) (20 results) (Low)
 - [assembly](#assembly) (20 results) (Informational)
 - [cyclomatic-complexity](#cyclomatic-complexity) (1 results) (Informational)
 - [dead-code](#dead-code) (2 results) (Informational)
 - [low-level-calls](#low-level-calls) (19 results) (Informational)
 - [missing-inheritance](#missing-inheritance) (8 results) (Informational)
 - [naming-convention](#naming-convention) (27 results) (Informational)
 - [too-many-digits](#too-many-digits) (1 results) (Informational)
 - [unindexed-event-address](#unindexed-event-address) (2 results) (Informational)
 - [unused-state](#unused-state) (1 results) (Informational)
## arbitrary-send-eth
Impact: High
Confidence: Medium
 - [ ] ID-0
[MinimalForwarder.execute(MinimalForwarder.ForwardRequest,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63) sends eth to arbitrary user
	Dangerous calls:
	- [(success,retdata) = req.to.call{gas: req.gas,value: req.value}(abi.encodePacked(req.data,req.from))](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L58-L60)

https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63


## encode-packed-collision
Impact: High
Confidence: High
 - [ ] ID-1
[SVGRenderer._buildOfferSVG(ISVGRenderer.OfferParams)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L94-L102) calls abi.encodePacked() with multiple dynamic arguments:
	- [string(abi.encodePacked(_offerSvgHeader(),_offerSvgServiceBlock(p),_offerSvgFinancialBlock(p),_offerSvgFooterBlock(p),</svg>))](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L95-L101)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L94-L102


 - [ ] ID-2
[SVGRenderer._buildReceiptSVG(ISVGRenderer.ReceiptParams)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L201-L215) calls abi.encodePacked() with multiple dynamic arguments:
	- [string(abi.encodePacked(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 520" width="380" height="520">,<rect width="380" height="520" fill="#0a0a0a" rx="12"/>,<rect width="380" height="4" fill="#ffffff" rx="2"/>,<text x="190" y="38" text-anchor="middle" font-family="monospace,Courier New" font-size="16" fill="#ffffff" font-weight="bold" letter-spacing="2">HEXSEAL</text>,<text x="190" y="54" text-anchor="middle" font-family="monospace,Courier New" font-size="9" fill="#444444" letter-spacing="3">JOB RECEIPT</text>,<line x1="20" y1="66" x2="360" y2="66" stroke="#1e1e1e" stroke-width="1" stroke-dasharray="5,4"/>,_receiptHeader(p.tokenId,p.createdAt),_receiptItems(p),_receiptFooter(p.client),<rect y="516" width="380" height="4" fill="#ffffff" rx="2"/>,</svg>))](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L202-L214)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L201-L215


 - [ ] ID-3
[SVGRenderer._receiptItems(ISVGRenderer.ReceiptParams)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L226-L231) calls abi.encodePacked() with multiple dynamic arguments:
	- [string(abi.encodePacked(_receiptItemsTop(p),_receiptItemsBottom(p)))](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L227-L230)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L226-L231


 - [ ] ID-4
[SVGRenderer._receiptItemsTop(ISVGRenderer.ReceiptParams)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L233-L241) calls abi.encodePacked() with multiple dynamic arguments:
	- [string(abi.encodePacked(_rowDark(130,TITLE,_truncate(_xmlEscape(p.title),20)),_rowDark(148,BUDGET,string(abi.encodePacked(_formatPrice(p.amount), USDC))),_rowDark(166,DEADLINE,string(abi.encodePacked(p.deadlineDays.toString(), DAYS))),_rowDark(184,REGION,_regionLabel(p.region)),<line x1="20" y1="196" x2="360" y2="196" stroke="#1e1e1e" stroke-width="1" stroke-dasharray="5,4"/>))](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L234-L240)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L233-L241


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-5
[SVGRenderer._fmtDate(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395) performs a multiplication on the result of a division:
	- [yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L381)
	- [doy = doe - (365 * yoe + yoe / 4 - yoe / 100)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L383)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395


 - [ ] ID-6
[Agreement._base64Encode(bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L929-L949) performs a multiplication on the result of a division:
	- [outLen = 4 * ((len + 2) / 3)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L933)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L929-L949


 - [ ] ID-7
[SVGRenderer._fmtDate(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395) performs a multiplication on the result of a division:
	- [era = z / 146097](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L379)
	- [doe = z - era * 146097](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L380)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395


 - [ ] ID-8
[SVGRenderer._fmtDate(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395) performs a multiplication on the result of a division:
	- [era = z / 146097](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L379)
	- [y = yoe + era * 400](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L382)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395


 - [ ] ID-9
[SVGRenderer._fmtDate(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395) performs a multiplication on the result of a division:
	- [mp = (5 * doy + 2) / 153](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L384)
	- [d = doy - (153 * mp + 2) / 5 + 1](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L385)

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L376-L395


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-10
[Agreement.status()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L419-L446) uses a dangerous strict equality:
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L422)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L419-L446


 - [ ] ID-11
[Agreement.timeLeft()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L789-L794) uses a dangerous strict equality:
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L790)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L789-L794


 - [ ] ID-12
[Agreement.arbiterTimeLeft()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L797-L802) uses a dangerous strict equality:
	- [disputedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L798)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L797-L802


 - [ ] ID-13
[Agreement.status()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L419-L446) uses a dangerous strict equality:
	- [fundedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L421)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L419-L446


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-14
[RegistryFacet.getDisputed().idx](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L245) is a local variable never initialized

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L245


 - [ ] ID-15
[RegistryFacet._filter(RegistryStorage.Layout,address,bool).idx](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L281) is a local variable never initialized

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L281


 - [ ] ID-16
[RegistryFacet.getActive().count](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L219) is a local variable never initialized

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L219


 - [ ] ID-17
[ArbiterRegistryFacet.raiseAppeal(address).eligibleVoters](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L624) is a local variable never initialized

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L624


 - [ ] ID-18
[RegistryFacet.getActive().idx](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L226) is a local variable never initialized

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L226


 - [ ] ID-19
[RegistryFacet.getDisputed().count](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L238) is a local variable never initialized

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L238


 - [ ] ID-20
[RegistryFacet._filter(RegistryStorage.Layout,address,bool).count](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L275) is a local variable never initialized

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L275


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-21
[JobBoardFacet.mintJobWithPermit(address,string,string,uint256,uint256,string,uint8,uint256,uint8,bytes32,bytes32)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L158-L215) ignores return value by [IJobReceiptMint(address(this)).mintJobReceipt(client,jobId,amount,deadlineDays,region,title)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L212)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L158-L215


 - [ ] ID-22
[JobBoardFacet.mintJob(string,string,uint256,uint256,string,uint8)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L220-L270) ignores return value by [IJobReceiptMint(address(this)).mintJobReceipt(client,jobId,amount,deadlineDays,region,title)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L267)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L220-L270


 - [ ] ID-23
[JobBoardFacet.acceptApplicant(uint256,address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L314-L364) ignores return value by [IJobReceiptBurn(address(this)).burnJobReceipt(jobId)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L361)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L314-L364


 - [ ] ID-24
[JobBoardFacet.cancelJob(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L367-L389) ignores return value by [IJobReceiptBurn(address(this)).burnJobReceipt(jobId)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L386)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L367-L389


## missing-zero-check
Impact: Low
Confidence: Medium
 - [ ] ID-25
[Agreement.constructor(address,address,address,uint256,uint256,string,address,address,address,address).arbiter_](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L368) lacks a zero-check on :
		- [arbiter = arbiter_](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L391)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L368


 - [ ] ID-26
[ArbiterRegistryFacet.clearStuckVerdict(address).agreement](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L766) lacks a zero-check on :
		- [(ok,st) = agreement.staticcall(abi.encodeWithSignature(status()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L769)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L766


 - [ ] ID-27
[ArbiterRegistryFacet.raiseAppeal(address).agreement](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600) lacks a zero-check on :
		- [(clientOk,clientData) = agreement.staticcall(abi.encodeWithSignature(client()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L614)
		- [(execOk,execData) = agreement.staticcall(abi.encodeWithSignature(executor()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L615)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600


 - [ ] ID-28
[ArbiterRegistryFacet.finalizeVerdict(address).agreement](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444) lacks a zero-check on :
		- [(ok,ret) = agreement.call(abi.encodeWithSignature(resolveDispute(bool),v.clientWins))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L457-L459)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444


 - [ ] ID-29
[JobBoardFacet.acceptApplicant(uint256,address).agreementAddr](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L317) lacks a zero-check on :
		- [(funded,None) = agreementAddr.call(abi.encodeWithSignature(fundFromFactory()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L356)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L317


 - [ ] ID-30
[FactoryFacet.deployAndFund(address,address,uint256,uint256,string,uint8).agreementAddress](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L190) lacks a zero-check on :
		- [(success,None) = agreementAddress.call(abi.encodeWithSignature(fundFromFactory()))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L218)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L190


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-31
Reentrancy in [Agreement.resolveDispute(bool)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L599-L626):
	External calls:
	- [_settlePending()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L613)
		- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L197-L199)
		- [usdc.safeTransfer(client,pending)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L958)
	- [_complete(Status.RESOLVED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L617)
		- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
		- [IReputationFacet(diamond).autoAwardXP(address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L977)
	State variables written after the call(s):
	- [_complete(Status.RESOLVED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L617)
		- [_finalStatus = newStatus](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L965)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L599-L626


 - [ ] ID-32
Reentrancy in [Agreement.resolveDispute(bool)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L599-L626):
	External calls:
	- [_settlePending()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L613)
		- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L197-L199)
		- [usdc.safeTransfer(client,pending)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L958)
	- [_complete(Status.RESOLVED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L620)
		- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
		- [IReputationFacet(diamond).autoAwardXP(address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L977)
	State variables written after the call(s):
	- [_complete(Status.RESOLVED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L620)
		- [_finalStatus = newStatus](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L965)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L599-L626


 - [ ] ID-33
Reentrancy in [Agreement.triggerArbiterTimeout()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L671-L692):
	External calls:
	- [_settlePending()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L682)
		- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L197-L199)
		- [usdc.safeTransfer(client,pending)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L958)
	- [_complete(Status.REFUNDED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L685)
		- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
		- [IReputationFacet(diamond).autoAwardXP(address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L977)
	State variables written after the call(s):
	- [_complete(Status.REFUNDED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L685)
		- [_finalStatus = newStatus](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L965)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L671-L692


 - [ ] ID-34
Reentrancy in [Agreement.release()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L534-L550):
	External calls:
	- [_settlePending()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L543)
		- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L197-L199)
		- [usdc.safeTransfer(client,pending)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L958)
	- [_complete(Status.COMPLETED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L546)
		- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
		- [IReputationFacet(diamond).autoAwardXP(address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L977)
	State variables written after the call(s):
	- [_complete(Status.COMPLETED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L546)
		- [_finalStatus = newStatus](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L965)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L534-L550


 - [ ] ID-35
Reentrancy in [Agreement.triggerAutoApprove()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L554-L566):
	External calls:
	- [_settlePending()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L559)
		- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L197-L199)
		- [usdc.safeTransfer(client,pending)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L958)
	- [_complete(Status.COMPLETED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L562)
		- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
		- [IReputationFacet(diamond).autoAwardXP(address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L977)
	State variables written after the call(s):
	- [_complete(Status.COMPLETED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L562)
		- [_finalStatus = newStatus](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L965)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L554-L566


 - [ ] ID-36
Reentrancy in [Agreement.fund()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L462-L482):
	External calls:
	- [usdc.safeTransferFrom(sender,address(this),amount)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L471)
	State variables written after the call(s):
	- [_mint(client,TOKEN_ID)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L474)
		- [_balances[to] ++](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L117)
	- [_mint(executor,EXECUTOR_TOKEN_ID)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L475)
		- [_balances[to] ++](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L117)
	- [_mint(client,TOKEN_ID)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L474)
		- [_owners[tokenId] = to](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L118)
	- [_mint(executor,EXECUTOR_TOKEN_ID)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L475)
		- [_owners[tokenId] = to](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L118)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L462-L482


 - [ ] ID-37
Reentrancy in [Agreement.triggerDeadlineTimeout()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L649-L667):
	External calls:
	- [_settlePending()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L658)
		- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L197-L199)
		- [usdc.safeTransfer(client,pending)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L958)
	- [_complete(Status.REFUNDED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L661)
		- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
		- [IReputationFacet(diamond).autoAwardXP(address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L977)
	State variables written after the call(s):
	- [_complete(Status.REFUNDED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L661)
		- [_finalStatus = newStatus](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L965)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L649-L667


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-38
Reentrancy in [ArbiterRegistryFacet.fundVault(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L724-L731):
	External calls:
	- [ok = IUSDCFull(usdc).transferFrom(msg.sender,address(this),amount)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L727)
	Event emitted after the call(s):
	- [VaultFunded(msg.sender,amount)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L730)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L724-L731


 - [ ] ID-39
Reentrancy in [FactoryFacet.deployAndFund(address,address,uint256,uint256,string,uint8)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L183-L223):
	External calls:
	- [_safeTransferFrom(fs.usdc,client,fs.feeRecipient,fee)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L206)
		- [(success,data) = token.call(abi.encodeWithSelector(0x23b872dd,from,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L228-L230)
	- [agreementAddress = IAgreementDeployer(fs.agreementDeployer).deploy(client,executor,address(0),amount,deadlineDays,terms,fs.diamond,fs.usdc,fs.trustedForwarder,address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L208-L212)
	- [IRegistry(fs.diamond).register(agreementAddress,client,executor,amount)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L214)
	- [_safeTransferFrom(fs.usdc,client,agreementAddress,amount)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L216)
		- [(success,data) = token.call(abi.encodeWithSelector(0x23b872dd,from,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L228-L230)
	- [(success,None) = agreementAddress.call(abi.encodeWithSignature(fundFromFactory()))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L218)
	Event emitted after the call(s):
	- [AgreementDeployed(agreementAddress,client,executor,amount,region,fee)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L221)
	- [DealFunded(agreementAddress,client,amount)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L222)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L183-L223


 - [ ] ID-40
Reentrancy in [MinimalForwarder.execute(MinimalForwarder.ForwardRequest,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63):
	External calls:
	- [(success,retdata) = req.to.call{gas: req.gas,value: req.value}(abi.encodePacked(req.data,req.from))](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L58-L60)
	Event emitted after the call(s):
	- [Executed(req.from,req.to,success)](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L62)

https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63


 - [ ] ID-41
Reentrancy in [ArbiterRegistryFacet.applyAsArbiter()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L221-L244):
	External calls:
	- [bondOk = IUSDCFull(usdc).transferFrom(caller,address(this),ARBITER_BOND)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L235)
	Event emitted after the call(s):
	- [ArbiterAdded(caller)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L242)
	- [ArbiterApplied(caller)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L243)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L221-L244


 - [ ] ID-42
Reentrancy in [FactoryFacet.deployAgreement(address,address,address,uint256,uint256,string,uint8)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L134-L170):
	External calls:
	- [_safeTransferFrom(fs.usdc,msg.sender,fs.feeRecipient,fee)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L158)
		- [(success,data) = token.call(abi.encodeWithSelector(0x23b872dd,from,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L228-L230)
	- [agreementAddress = IAgreementDeployer(fs.agreementDeployer).deploy(client,executor,address(0),amount,deadlineDays,terms,fs.diamond,fs.usdc,fs.trustedForwarder,address(this))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L161-L165)
	- [IRegistry(fs.diamond).register(agreementAddress,client,executor,amount)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L167)
	Event emitted after the call(s):
	- [AgreementDeployed(agreementAddress,client,executor,amount,region,fee)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L169)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L134-L170


 - [ ] ID-43
Reentrancy in [ArbiterRegistryFacet.removeArbiter(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L294-L316):
	External calls:
	- [ok = IUSDCFull(usdc).transfer(arbiter,bond)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L311)
	Event emitted after the call(s):
	- [ArbiterRemoved(arbiter)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L315)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L294-L316


 - [ ] ID-44
Reentrancy in [Agreement.raiseDispute()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L570-L594):
	External calls:
	- [_updateRegistry(ISignatureRegistry.AgreementStatus.DISPUTED)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L591)
		- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
	Event emitted after the call(s):
	- [DisputeRaised(sender)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L593)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L570-L594


 - [ ] ID-45
Reentrancy in [ArbiterRegistryFacet.claimDispute(address,bytes32)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L330-L370):
	External calls:
	- [(setOk,None) = agreement.call(abi.encodeWithSignature(setArbiter(address),address(this)))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L360-L362)
	Event emitted after the call(s):
	- [DisputeClaimed(agreement,caller)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L369)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L330-L370


 - [ ] ID-46
Reentrancy in [ArbiterRegistryFacet.withdrawArbiterReward()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L707-L721):
	External calls:
	- [ok = IUSDCFull(usdc).transfer(caller,amount)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L717)
	Event emitted after the call(s):
	- [ArbiterRewardWithdrawn(caller,amount)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L720)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L707-L721


 - [ ] ID-47
Reentrancy in [ArbiterRegistryFacet.resignAsArbiter()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L250-L276):
	External calls:
	- [ok = IUSDCFull(usdc).transfer(caller,bond)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L271)
	Event emitted after the call(s):
	- [ArbiterResigned(caller,bond)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L275)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L250-L276


 - [ ] ID-48
Reentrancy in [ArbiterRegistryFacet.finalizeVerdict(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484):
	External calls:
	- [(ok,ret) = agreement.call(abi.encodeWithSignature(resolveDispute(bool),v.clientWins))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L457-L459)
	Event emitted after the call(s):
	- [ArbiterRewarded(v.arbiter,d.rewardPerDispute)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L480)
	- [VerdictFinalized(agreement,v.arbiter,v.clientWins)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L483)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484


 - [ ] ID-49
Reentrancy in [Agreement._updateRegistry(ISignatureRegistry.AgreementStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L985-L991):
	External calls:
	- [ISignatureRegistry(diamond).updateStatus(address(this),regStatus)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L986-L990)
	Event emitted after the call(s):
	- [RegistrySyncFailed(address(this),uint8(regStatus))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L989)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L985-L991


 - [ ] ID-50
Reentrancy in [ArbiterRegistryFacet.resolveAppeal(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L669-L702):
	External calls:
	- [refundOk = IUSDCFull(usdc).transfer(v.appellant,APPEAL_DEPOSIT)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L695)
	Event emitted after the call(s):
	- [AppealResolved(agreement,v.appellant,overturn)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L701)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L669-L702


 - [ ] ID-51
Reentrancy in [ArbiterRegistryFacet.releaseDisputeClaim(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L372-L392):
	External calls:
	- [(ok,None) = agreement.call(abi.encodeWithSignature(setArbiter(address),address(0)))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L386-L388)
	Event emitted after the call(s):
	- [DisputeReleased(agreement,current)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L391)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L372-L392


 - [ ] ID-52
Reentrancy in [ArbiterRegistryFacet.raiseAppeal(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600-L641):
	External calls:
	- [ok = IUSDCFull(usdc).transferFrom(caller,address(this),APPEAL_DEPOSIT)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L632)
	Event emitted after the call(s):
	- [AppealRaised(agreement,caller)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L640)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600-L641


## return-bomb
Impact: Low
Confidence: Medium
 - [ ] ID-53
[MinimalForwarder.execute(MinimalForwarder.ForwardRequest,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63) tries to limit the gas of an external call that controls implicit decoding
	[(success,retdata) = req.to.call{gas: req.gas,value: req.value}(abi.encodePacked(req.data,req.from))](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L58-L60)

https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-54
[Agreement.markDone()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L518-L531) uses timestamp for comparisons
	Dangerous comparisons:
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L521)
	- [markedDoneAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L522)
	- [disputedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L523)
	- [block.timestamp > activatedAt + (deadlineDays * 86400) + DEADLINE_GRACE](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L526)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L518-L531


 - [ ] ID-55
[Agreement.triggerAutoApprove()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L554-L566) uses timestamp for comparisons
	Dangerous comparisons:
	- [markedDoneAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L555)
	- [disputedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L556)
	- [block.timestamp < markedDoneAt + AUTO_APPROVE_WINDOW](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L557)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L554-L566


 - [ ] ID-56
[ArbiterRegistryFacet.raiseAppeal(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600-L641) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp >= v.submittedAt + FINALIZE_DELAY](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L612)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600-L641


 - [ ] ID-57
[Agreement.raiseDispute()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L570-L594) uses timestamp for comparisons
	Dangerous comparisons:
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L574)
	- [disputedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L575)
	- [markedDoneAt != 0 && block.timestamp >= markedDoneAt + AUTO_APPROVE_WINDOW](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L578)
	- [markedDoneAt == 0 && block.timestamp > activatedAt + (deadlineDays * 86400) + DEADLINE_GRACE](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L585)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L570-L594


 - [ ] ID-58
[Agreement.arbiterTimeLeft()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L797-L802) uses timestamp for comparisons
	Dangerous comparisons:
	- [disputedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L798)
	- [block.timestamp >= deadline](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L800)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L797-L802


 - [ ] ID-59
[Agreement.fundFromFactory()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L486-L499) uses timestamp for comparisons
	Dangerous comparisons:
	- [fundedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L488)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L486-L499


 - [ ] ID-60
[Agreement.fund()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L462-L482) uses timestamp for comparisons
	Dangerous comparisons:
	- [fundedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L465)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L462-L482


 - [ ] ID-61
[Agreement.triggerActivationTimeout()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L630-L645) uses timestamp for comparisons
	Dangerous comparisons:
	- [fundedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L633)
	- [activatedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L634)
	- [block.timestamp <= fundedAt + ACTIVATION_WINDOW](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L635)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L630-L645


 - [ ] ID-62
[ArbiterRegistryFacet.voteOnAppeal(address,bool)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L644-L664) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp >= v.appealDeadline](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L653)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L644-L664


 - [ ] ID-63
[Agreement.triggerDeadlineTimeout()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L649-L667) uses timestamp for comparisons
	Dangerous comparisons:
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L652)
	- [disputedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L653)
	- [markedDoneAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L654)
	- [block.timestamp <= activatedAt + (deadlineDays * 86400) + DEADLINE_GRACE](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L656)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L649-L667


 - [ ] ID-64
[Agreement.activate()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L503-L515) uses timestamp for comparisons
	Dangerous comparisons:
	- [fundedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L506)
	- [activatedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L507)
	- [block.timestamp > fundedAt + ACTIVATION_WINDOW](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L510)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L503-L515


 - [ ] ID-65
[Agreement.release()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L534-L550) uses timestamp for comparisons
	Dangerous comparisons:
	- [markedDoneAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L537)
	- [disputedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L538)
	- [block.timestamp >= markedDoneAt + AUTO_APPROVE_WINDOW](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L541)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L534-L550


 - [ ] ID-66
[ArbiterRegistryFacet.finalizeVerdict(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484) uses timestamp for comparisons
	Dangerous comparisons:
	- [require(bool,string)(block.timestamp >= v.submittedAt + FINALIZE_DELAY,ArbiterRegistry: finalize delay not passed)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L451)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484


 - [ ] ID-67
[Agreement.resolveDispute(bool)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L599-L626) uses timestamp for comparisons
	Dangerous comparisons:
	- [disputedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L604)
	- [resolvedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L605)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L599-L626


 - [ ] ID-68
[ArbiterRegistryFacet.resolveAppeal(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L669-L702) uses timestamp for comparisons
	Dangerous comparisons:
	- [windowClosed = block.timestamp >= v.appealDeadline](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L677)
	- [! quorumReached && ! windowClosed](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L678)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L669-L702


 - [ ] ID-69
[Agreement.triggerArbiterTimeout()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L671-L692) uses timestamp for comparisons
	Dangerous comparisons:
	- [disputedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L674)
	- [resolvedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L675)
	- [block.timestamp <= disputedAt + DISPUTE_WINDOW](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L676)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L671-L692


 - [ ] ID-70
[ArbiterRegistryFacet.submitVerdict(address,bool)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L397-L440) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > disputedAt + disputeWindow](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L421)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L397-L440


 - [ ] ID-71
[Agreement.proposeExtra(uint256,string)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L699-L716) uses timestamp for comparisons
	Dangerous comparisons:
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L703)
	- [markedDoneAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L704)
	- [disputedAt != 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L705)
	- [block.timestamp > activatedAt + (deadlineDays * 86400)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L707)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L699-L716


 - [ ] ID-72
[Agreement.timeLeft()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L789-L794) uses timestamp for comparisons
	Dangerous comparisons:
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L790)
	- [block.timestamp >= deadline](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L792)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L789-L794


 - [ ] ID-73
[Agreement.status()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L419-L446) uses timestamp for comparisons
	Dangerous comparisons:
	- [fundedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L421)
	- [activatedAt == 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L422)
	- [disputedAt > 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L425)
	- [resolvedAt > 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L426)
	- [markedDoneAt > 0](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L432)
	- [block.timestamp >= markedDoneAt + AUTO_APPROVE_WINDOW](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L434)
	- [block.timestamp > activatedAt + (deadlineDays * 86400) + DEADLINE_GRACE](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L441)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L419-L446


## assembly
Impact: Informational
Confidence: High
 - [ ] ID-74
[JobBoardFacet._msgSender()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L142-L153) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L147-L149)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L142-L153


 - [ ] ID-75
[ArbiterRegistryFacet._msgSender()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L205-L212) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L208)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L205-L212


 - [ ] ID-76
[ServiceBoardFacet._msgSender()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L145-L156) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L150-L152)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L145-L156


 - [ ] ID-77
[DiamondGuard.status()](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L91-L94) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L93)

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L91-L94


 - [ ] ID-78
[ReceiptStorage.store()](https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L50-L53) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L52)

https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L50-L53


 - [ ] ID-79
[ArbiterRegistryFacet.finalizeVerdict(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L465)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484


 - [ ] ID-80
[ERC2771Context._msgSender()](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L180-L188) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L182-L184)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L180-L188


 - [ ] ID-81
[DiamondStorage.store()](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L74-L79) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L76-L78)

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L74-L79


 - [ ] ID-82
[ServiceBoardStorage.store()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L75-L78) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L77)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L75-L78


 - [ ] ID-83
[ArbiterRegistryStorage.data()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L88-L91) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L90)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L88-L91


 - [ ] ID-84
[AgreementDeployer.deploy(address,address,address,uint256,uint256,string,address,address,address,address)](https://github.com/Hexseal/Hexseal/blob/main/src/AgreementDeployer.sol#L38-L63) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/AgreementDeployer.sol#L59-L61)

https://github.com/Hexseal/Hexseal/blob/main/src/AgreementDeployer.sol#L38-L63


 - [ ] ID-85
[JobBoardStorage.store()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L88-L91) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L90)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L88-L91


 - [ ] ID-86
[ReputationStorage.data()](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ReputationFacet.sol#L46-L49) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ReputationFacet.sol#L48)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ReputationFacet.sol#L46-L49


 - [ ] ID-87
[DiamondCutLib.enforceHasContractCode(address,string)](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L259-L265) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L261-L263)

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L259-L265


 - [ ] ID-88
[FactoryFacet._msgSender()](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L174-L181) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L177)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L174-L181


 - [ ] ID-89
[DiamondProxy.fallback()](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L283-L295) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L287-L294)

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L283-L295


 - [ ] ID-90
[FactoryStorage.store()](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L46-L51) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L48-L50)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L46-L51


 - [ ] ID-91
[DiamondGuard.setStatus(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L96-L99) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L98)

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L96-L99


 - [ ] ID-92
[RegistryStorage.store()](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L51-L56) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L53-L55)

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L51-L56


 - [ ] ID-93
[DiamondCutLib.initializeDiamondCut(address,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244-L257) uses assembly
	- [INLINE ASM](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L250-L252)

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244-L257


## cyclomatic-complexity
Impact: Informational
Confidence: High
 - [ ] ID-94
[SVGRenderer._xmlEscape(string)](https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L351-L374) has a high cyclomatic complexity (12).

https://github.com/Hexseal/Hexseal/blob/main/src/SVGRenderer.sol#L351-L374


## dead-code
Impact: Informational
Confidence: Medium
 - [ ] ID-95
[MinimalERC721._beforeTransfer(address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L96) is never used and should be removed

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L96


 - [ ] ID-96
[MinimalERC721._burn(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L122-L128) is never used and should be removed

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L122-L128


## low-level-calls
Impact: Informational
Confidence: High
 - [ ] ID-97
Low level call in [ServiceBoardFacet.acceptRequest(uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L434-L502):
	- [(ok,ret) = address(this).call(abi.encodeWithSelector(IFactory.deployAgreement.selector,client,sender,address(0),amount,deadline,terms,region))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L459-L470)
	- [(funded,None) = agreementAddr.call(abi.encodeWithSignature(fundFromFactory()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L481)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L434-L502


 - [ ] ID-98
Low level call in [ArbiterRegistryFacet.raiseAppeal(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600-L641):
	- [(clientOk,clientData) = agreement.staticcall(abi.encodeWithSignature(client()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L614)
	- [(execOk,execData) = agreement.staticcall(abi.encodeWithSignature(executor()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L615)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L600-L641


 - [ ] ID-99
Low level call in [FactoryFacet._safeTransferFrom(address,address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L227-L232):
	- [(success,data) = token.call(abi.encodeWithSelector(0x23b872dd,from,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L228-L230)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L227-L232


 - [ ] ID-100
Low level call in [JobBoardFacet.acceptApplicant(uint256,address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L314-L364):
	- [(ok,ret) = address(this).call(abi.encodeWithSelector(IFactory.deployAgreement.selector,job.client,executor,address(0),job.amount,job.deadlineDays,job.terms,job.region))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L331-L342)
	- [(funded,None) = agreementAddr.call(abi.encodeWithSignature(fundFromFactory()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L356)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L314-L364


 - [ ] ID-101
Low level call in [FactoryFacet.deployAndFund(address,address,uint256,uint256,string,uint8)](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L183-L223):
	- [(success,None) = agreementAddress.call(abi.encodeWithSignature(fundFromFactory()))](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L218)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L183-L223


 - [ ] ID-102
Low level call in [JobBoardFacet._safeTransfer(address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L478-L483):
	- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L479-L481)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L478-L483


 - [ ] ID-103
Low level call in [ArbiterRegistryFacet.submitVerdict(address,bool)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L397-L440):
	- [(ok,st) = agreement.staticcall(abi.encodeWithSignature(status()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L405)
	- [(disputedOk,disputedData) = agreement.staticcall(abi.encodeWithSignature(disputedAt()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L413)
	- [(windowOk,windowData) = agreement.staticcall(abi.encodeWithSignature(DISPUTE_WINDOW()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L417)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L397-L440


 - [ ] ID-104
Low level call in [MinimalForwarder.execute(MinimalForwarder.ForwardRequest,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63):
	- [(success,retdata) = req.to.call{gas: req.gas,value: req.value}(abi.encodePacked(req.data,req.from))](https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L58-L60)

https://github.com/Hexseal/Hexseal/blob/main/src/MinimalForwarder.sol#L48-L63


 - [ ] ID-105
Low level call in [Agreement.setArbiter(address)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L404-L415):
	- [(ok,data) = diamond.staticcall(abi.encodeWithSignature(isRegisteredArbiter(address),newArbiter))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L409-L411)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L404-L415


 - [ ] ID-106
Low level call in [ArbiterRegistryFacet.claimDispute(address,bytes32)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L330-L370):
	- [(statusOk,statusData) = agreement.staticcall(abi.encodeWithSignature(status()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L344-L346)
	- [(clientOk,clientData) = agreement.staticcall(abi.encodeWithSignature(client()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L352)
	- [(execOk,execData) = agreement.staticcall(abi.encodeWithSignature(executor()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L353)
	- [(setOk,None) = agreement.call(abi.encodeWithSignature(setArbiter(address),address(this)))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L360-L362)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L330-L370


 - [ ] ID-107
Low level call in [DiamondCutLib.initializeDiamondCut(address,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244-L257):
	- [(success,errData) = _init.delegatecall(_calldata)](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L247)

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244-L257


 - [ ] ID-108
Low level call in [ArbiterRegistryFacet.clearStuckVerdict(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L766-L773):
	- [(ok,st) = agreement.staticcall(abi.encodeWithSignature(status()))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L769)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L766-L773


 - [ ] ID-109
Low level call in [SafeUSDC.safeTransferFrom(address,address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L203-L208):
	- [(success,data) = token.call(abi.encodeWithSelector(0x23b872dd,from,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L204-L206)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L203-L208


 - [ ] ID-110
Low level call in [ServiceBoardFacet._safeTransferFrom(address,address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L652-L657):
	- [(success,data) = token.call(abi.encodeWithSelector(0x23b872dd,from,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L653-L655)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L652-L657


 - [ ] ID-111
Low level call in [ServiceBoardFacet._safeTransfer(address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L659-L664):
	- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L660-L662)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ServiceBoardFacet.sol#L659-L664


 - [ ] ID-112
Low level call in [ArbiterRegistryFacet.finalizeVerdict(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484):
	- [(ok,ret) = agreement.call(abi.encodeWithSignature(resolveDispute(bool),v.clientWins))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L457-L459)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L444-L484


 - [ ] ID-113
Low level call in [ArbiterRegistryFacet.releaseDisputeClaim(address)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L372-L392):
	- [(ok,None) = agreement.call(abi.encodeWithSignature(setArbiter(address),address(0)))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L386-L388)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L372-L392


 - [ ] ID-114
Low level call in [SafeUSDC.safeTransfer(address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L196-L201):
	- [(success,data) = token.call(abi.encodeWithSelector(0xa9059cbb,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L197-L199)

https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L196-L201


 - [ ] ID-115
Low level call in [JobBoardFacet._safeTransferFrom(address,address,address,uint256)](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L471-L476):
	- [(success,data) = token.call(abi.encodeWithSelector(0x23b872dd,from,to,amount))](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L472-L474)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L471-L476


## missing-inheritance
Impact: Informational
Confidence: High
 - [ ] ID-116
[ArbiterRegistryFacet](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L96-L814) should inherit from [IArbiterRegistry](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L235-L237)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L96-L814


 - [ ] ID-117
[JobReceiptFacet](https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L58-L230) should inherit from [IJobReceiptBurn](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L24-L26)

https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L58-L230


 - [ ] ID-118
[FactoryFacet](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L56-L294) should inherit from [IFactory](https://github.com/Hexseal/Hexseal/blob/main/src/facets/IFactory.sol#L4-L14)

https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L56-L294


 - [ ] ID-119
[RegistryFacet](https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L61-L290) should inherit from [IRegistry](https://github.com/Hexseal/Hexseal/blob/main/src/FactoryFacet.sol#L15-L18)

https://github.com/Hexseal/Hexseal/blob/main/src/RegistryFacet.sol#L61-L290


 - [ ] ID-120
[JobReceiptFacet](https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L58-L230) should inherit from [IJobReceiptMint](https://github.com/Hexseal/Hexseal/blob/main/src/facets/JobBoardFacet.sol#L28-L37)

https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L58-L230


 - [ ] ID-121
[ReputationFacet](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ReputationFacet.sol#L54-L343) should inherit from [IReputationFacet](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L217-L220)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ReputationFacet.sol#L54-L343


 - [ ] ID-122
[JobReceiptFacet](https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L58-L230) should inherit from [IERC20](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L213-L215)

https://github.com/Hexseal/Hexseal/blob/main/src/JobReceiptFacet.sol#L58-L230


 - [ ] ID-123
[ArbiterRegistryFacet](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L96-L814) should inherit from [IArbiterRegistryFacet](https://github.com/Hexseal/Hexseal/blob/main/src/Agreement.sol#L222-L225)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L96-L814


## naming-convention
Impact: Informational
Confidence: High
 - [ ] ID-124
Parameter [DiamondLoupeFacet.supportsInterface(bytes4)._interfaceId](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L344) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L344


 - [ ] ID-125
Parameter [DiamondCutLib.replaceFunctions(address,bytes4[])._functionSelectors](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L169) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L169


 - [ ] ID-126
Parameter [DiamondCutLib.initializeDiamondCut(address,bytes)._init](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244


 - [ ] ID-127
Parameter [DiamondLoupeFacet.facetAddress(bytes4)._functionSelector](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L339) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L339


 - [ ] ID-128
Parameter [DiamondCutFacet.diamondCut(IDiamondCut.FacetCut[],address,bytes)._diamondCut](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L305) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L305


 - [ ] ID-129
Parameter [DiamondCutFacet.diamondCut(IDiamondCut.FacetCut[],address,bytes)._init](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L306) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L306


 - [ ] ID-130
Parameter [DiamondCutLib.addFunction(DiamondStorage.Layout,bytes4,uint96,address)._facetAddress](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L208) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L208


 - [ ] ID-131
Parameter [DiamondCutLib.diamondCut(IDiamondCut.FacetCut[],address,bytes)._diamondCut](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L132) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L132


 - [ ] ID-132
Parameter [DiamondCutLib.removeFunctions(address,bytes4[])._facetAddress](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L187) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L187


 - [ ] ID-133
Parameter [DiamondCutLib.addFacet(DiamondStorage.Layout,address)._facetAddress](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L198) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L198


 - [ ] ID-134
Parameter [OwnershipFacet.transferOwnership(address)._newOwner](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L356) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L356


 - [ ] ID-135
Parameter [DiamondCutLib.addFunctions(address,bytes4[])._functionSelectors](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L152) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L152


 - [ ] ID-136
Parameter [DiamondCutLib.addFunction(DiamondStorage.Layout,bytes4,uint96,address)._selector](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L206) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L206


 - [ ] ID-137
Parameter [DiamondCutLib.removeFunction(DiamondStorage.Layout,address,bytes4)._selector](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L218) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L218


 - [ ] ID-138
Parameter [DiamondCutLib.addFunctions(address,bytes4[])._facetAddress](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L152) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L152


 - [ ] ID-139
Parameter [DiamondCutLib.addFunction(DiamondStorage.Layout,bytes4,uint96,address)._selectorPosition](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L207) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L207


 - [ ] ID-140
Parameter [DiamondCutLib.diamondCut(IDiamondCut.FacetCut[],address,bytes)._init](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L133) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L133


 - [ ] ID-141
Parameter [DiamondCutLib.initializeDiamondCut(address,bytes)._calldata](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L244


 - [ ] ID-142
Parameter [DiamondCutLib.enforceHasContractCode(address,string)._contract](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L259) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L259


 - [ ] ID-143
Parameter [DiamondCutLib.enforceHasContractCode(address,string)._errorMessage](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L259) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L259


 - [ ] ID-144
Parameter [DiamondLoupeFacet.facetFunctionSelectors(address)._facet](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L329) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L329


 - [ ] ID-145
Parameter [DiamondCutLib.removeFunction(DiamondStorage.Layout,address,bytes4)._facetAddress](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L217) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L217


 - [ ] ID-146
Parameter [DiamondCutLib.removeFunctions(address,bytes4[])._functionSelectors](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L187) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L187


 - [ ] ID-147
Parameter [DiamondCutLib.diamondCut(IDiamondCut.FacetCut[],address,bytes)._calldata](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L134) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L134


 - [ ] ID-148
Parameter [OwnershipLib.setContractOwner(address)._newOwner](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L107) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L107


 - [ ] ID-149
Parameter [DiamondCutFacet.diamondCut(IDiamondCut.FacetCut[],address,bytes)._calldata](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L307) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L307


 - [ ] ID-150
Parameter [DiamondCutLib.replaceFunctions(address,bytes4[])._facetAddress](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L169) is not in mixedCase

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L169


## too-many-digits
Impact: Informational
Confidence: Medium
 - [ ] ID-151
[AgreementDeployer.deploy(address,address,address,uint256,uint256,string,address,address,address,address)](https://github.com/Hexseal/Hexseal/blob/main/src/AgreementDeployer.sol#L38-L63) uses literals with too many digits:
	- [bytecode = abi.encodePacked(type()(Agreement).creationCode,abi.encode(client,executor,arbiter,amount,deadlineDays,terms,diamond,usdc,trustedForwarder,factory))](https://github.com/Hexseal/Hexseal/blob/main/src/AgreementDeployer.sol#L51-L58)

https://github.com/Hexseal/Hexseal/blob/main/src/AgreementDeployer.sol#L38-L63


## unindexed-event-address
Impact: Informational
Confidence: High
 - [ ] ID-152
Event [IDiamondCut.DiamondCut(IDiamondCut.FacetCut[],address,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L27) has address parameters but no indexed parameters

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L27


 - [ ] ID-153
Event [DiamondCutLib.DiamondCut(IDiamondCut.FacetCut[],address,bytes)](https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L126) has address parameters but no indexed parameters

https://github.com/Hexseal/Hexseal/blob/main/src/DiamondProxy.sol#L126


## unused-state
Impact: Informational
Confidence: High
 - [ ] ID-154
[ArbiterRegistryFacet.DEFAULT_REWARD](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L104) is never used in [ArbiterRegistryFacet](https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L96-L814)

https://github.com/Hexseal/Hexseal/blob/main/src/facets/ArbiterRegistryFacet.sol#L104


