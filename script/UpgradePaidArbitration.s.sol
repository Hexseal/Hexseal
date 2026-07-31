// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// UpgradePaidArbitration.s.sol
//
// Переводит ЖИВОЙ диамонд 0x760F07367888C62f7c2Dfb619A5e534132855ce5 на
// платный вызов арбитра: сторона спора может доплатить до порога
// (`arbiterFloor`), чтобы арбитр забрал спор, а не ждал добровольца на
// мелком котле; доплата достаётся арбитру при вердикте и возвращается
// плательщику, если спор кончился без вердикта (таймаут/dispute split).
// Заодно считается, скольким участникам спор закрылся без вердикта
// (`getUnresolvedDisputes`). См. docs/superpowers/plans/2026-07-31-*
// (шесть задач, 1-4 — контракты, эта задача — выкатка) и git log:
// abeb1c7 .. 3935f12 (порог -> доплата -> возврат -> счётчик).
//
// ── БАЗА ОТСЧЁТА — ЦЕПЬ, НЕ main. ────────────────────────────────────────
// Живой диамонд собран script/DeployFull.s.sol 25.07.2026 и с тех пор
// патчился (см. заголовок script/UpgradeFeeModel.s.sol для полной цепочки).
// Последний реальный (не dry-run) патч на момент написания этого файла —
// сам UpgradeFeeModel.s.sol (30.07.2026): Replace 106 + Add 14 селекторов
// по шести фасетам, включая ArbiterRegistryFacet (Replace 44 старых + Add 3
// новых: creditDisputeFee, withdrawTreasurySlice, getTreasurySlice — сбор
// 3% со спорной суммы). Живой ArbiterRegistryFacet сейчас
// 0xc60bf9da775555859df5c7180ad19dcbc181d342 (broadcast/UpgradeFeeModel.s.sol
// /84532/run-latest.json), а НЕ 0xf707aa69... из DeployFull. ReputationFacet
// патчей не получал ни разу — живой адрес 0xce3bc88f78b1576576a3196bcaf09
// faba709701f, тот, что развернул DeployFull 25.07.
//
// Как и в UpgradeFeeModel: этот скрипт читает ТЕКУЩИЕ адреса и селекторы
// С ЦЕПИ через facetAddress()/facets() в момент запуска, не подставляет
// константой ничего из перечисленного выше — корректность не зависит от
// того, патчили ли диамонд ещё раз в промежутке.
//
// ── ЧТО МЕНЯЕТСЯ ─────────────────────────────────────────────────────────
// Два фасета: ArbiterRegistryFacet, ReputationFacet.
//
// На цепи сейчас (после UpgradeFeeModel) ArbiterRegistryFacet несёт 47
// селекторов, ReputationFacet — 8. В текущих исходниках у тех же двух
// фасетов — 54 и 9. Add — РОВНО ВОСЕМЬ:
//
//   ArbiterRegistryFacet (7): fundDispute, getArbiterFloor,
//                              getDisputeBounty, getRefundableBounty,
//                              quoteDisputeTopUp, setArbiterFloor,
//                              withdrawDisputeBounty
//   ReputationFacet      (1): getUnresolvedDisputes
//
// ── ДЕЙСТВИЙ РОВНО ДВА, А НЕ ТРИ ──────────────────────────────────────────
// Ранний план (docs/superpowers/sdd/2026-07-31-paid-arbitration/) закладывал
// третье действие — Remove `setRewardPerDispute`/`getRewardPerDispute`,
// снятие плоской выплаты банка за спор (отвергнута дизайном 28 июля,
// см. заголовок ArbiterRegistryFacet.sol). Это ОТМЕНЕНО ДО ЭТОГО СКРИПТА,
// не в нём: обе функции по-прежнему в исходниках и по-прежнему смонтированы
// сегодня (Replace, не Remove).
//
//   - setRewardPerDispute(uint256) теперь `external pure` и безусловно
//     ревертит кастомной ошибкой RewardPathRetired() —
//     ArbiterRegistryFacet.sol:1003. Причина не removeFunctions, а то, что
//     восемь исторических скриптов в script/ ссылаются на её селектор в
//     списках монтирования при компиляции (grep: DeployFull.s.sol,
//     PatchArbiterAutoCleanup.s.sol, PatchArbiterClearStuck.s.sol,
//     UpgradeArbiterRegistryFacetAppeal.s.sol,
//     UpgradeArbiterRegistryFacetBondAndGuard.s.sol,
//     UpgradeArbiterRegistryFacetDemotion.s.sol,
//     UpgradeArbiterRegistryV3.s.sol, UpgradeFeeModel.s.sol) — удаление
//     функции из исходника разваливает сборку всей папки script/, а
//     broadcast/ в .gitignore, так что эти скрипты — единственная
//     оставшаяся запись о произошедших апгрейдах.
//   - getRewardPerDispute() осталась legacy-геттером: поле, которое она
//     читает, больше никто не пишет, значение всегда 0
//     (ArbiterRegistryFacet.sol:1219).
//
// Селектор ни одной из двух функций не поменялся — значит для diamondCut
// это ОБЫЧНЫЙ Replace, как и остальные 45 неизменившихся сигнатурой функций
// фасета. Remove здесь был бы не просто лишним, а ОШИБОЧНЫМ: снял бы живую,
// вызываемую (пусть и всегда ревертящую предсказуемо) функцию с диамонда,
// заменив предсказуемый кастомный revert на "Diamond: function not found".
//
// ── REPLACE И ADD — ОТДЕЛЬНЫЕ ЗАПИСИ FacetCut ────────────────────────────
// Ни один селектор не в обоих: DiamondCutLib.replaceFunctions
// (DiamondProxy.sol:184) ревертит на `oldFacetAddress == _facetAddress`
// (тот же адрес — Replace бессмыслен и на "селектор не смонтирован"),
// DiamondCutLib.addFunctions (DiamondProxy.sol:167) ревертит на
// `oldFacetAddress != address(0)` (селектор уже существует). Оба списка
// для каждого фасета проверяются на цепи ДО broadcast (см. run() —
// _checkReplaceGroup/_checkAddGroup).
//
// ── СПИСКИ СЕЛЕКТОРОВ — ИЗ ИСХОДНИКОВ, НЕ РУКАМИ ──────────────────────────
// Как в UpgradeFeeModel.s.sol: каждый список — `public pure` функция вида
// `<Facet>.<fn>.selector`, единый источник правды для
// buildPaidArbitrationCuts() ниже и для
// test/UpgradePaidArbitrationSelectors.t.sol, который сверяет их с
// `out/<Facet>.sol/<Facet>.json`.methodIdentifiers.
//
// ── `_init` НЕ НУЖЕН ──────────────────────────────────────────────────────
// `arbiterFloor` читается через getArbiterFloor(), которая подставляет
// дефолт 10 USDC прямо в геттере на нулевом поле хранилища
// (ArbiterRegistryFacet.sol:1224-1227: `f == 0 ? DEFAULT_ARBITER_FLOOR : f`).
// Засевать нечего — в отличие от feeFloor в UpgradeFeeModel (там нулевой
// floor означает "не настроено", и quote() ревертит), здесь ноль в
// хранилище — это ВАЛИДНОЕ и ожидаемое стартовое состояние, интерпретируемое
// как "порог по умолчанию".
//
// ── ⚠️  ПРЕДУПРЕЖДЕНИЕ ОБ ОТКАТЕ — ПРОВЕРЕННЫЙ ФАКТ, НЕ ДОГАДКА ───────────
// Восемь Add-селекторов этого cut'а НЕЛЬЗЯ откатывать через Replace на
// старый (пред-этого-апгрейда) адрес фасета. DiamondCutLib.replaceFunctions
// (DiamondProxy.sol:184-198) проверяет только, что целевой facetAddress
// отличается от текущего и имеет ненулевой code.length — реализует ли он
// САМ СЕЛЕКТОР, не проверяется НИКОГДА. Такой Replace пройдёт успешно,
// facets()/facetFunctionSelectors() покажут селектор смонтированным на
// старом адресе, а каждый вызов будет ревертить ПУСТЫМ returndata (сам
// адрес не содержит кода для этого селектора — упадёт в fallback старого
// фасета либо просто в пустоту, в зависимости от того, что там есть).
// Невидимо для мониторинга уровня фасетов: loupe лжёт, что всё смонтировано
// штатно.
//
// Единственно верный способ откатить восемь Add-селекторов — Remove
// (action 2, `facetAddress` ОБЯЗАН быть address(0) — DiamondProxy.sol:194).
// Печатается прямым текстом в конце run() ниже.
//
// Usage (сухой прогон — сначала всегда он):
//   forge script script/UpgradePaidArbitration.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
//
// Usage (боевой запуск):
//   forge script script/UpgradePaidArbitration.s.sol \
//     --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvv
// ============================================================

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../src/DiamondProxy.sol";
import "../src/facets/ArbiterRegistryFacet.sol";
import "../src/facets/ReputationFacet.sol";

contract UpgradePaidArbitration is Script {

    function run() external {
        address diamond     = vm.envAddress("DIAMOND_ADDRESS");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(deployerKey);

        // ── Pre-flight ────────────────────────────────────────────────────
        require(diamond != address(0), "UpgradePaidArbitration: DIAMOND_ADDRESS is zero");
        require(diamond.code.length > 0, "UpgradePaidArbitration: DIAMOND_ADDRESS has no code");

        address currentOwner = OwnershipFacet(diamond).owner();
        require(
            currentOwner == broadcaster,
            "UpgradePaidArbitration: PRIVATE_KEY is not the diamond owner - diamondCut would revert"
        );

        console.log("=== UpgradePaidArbitration: pre-flight ===");
        console.log("Diamond: ", diamond);
        console.log("Owner:   ", currentOwner);
        console.log("");

        bytes4[] memory arbiterReplace = arbiterRegistryFacetReplaceSelectors();
        bytes4[] memory arbiterAdd     = arbiterRegistryFacetAddSelectors();
        bytes4[] memory reputeReplace  = reputationFacetReplaceSelectors();
        bytes4[] memory reputeAdd      = reputationFacetAddSelectors();

        // Каждый Replace-селектор смонтирован сейчас, и все селекторы одного
        // фасета указывают на ОДИН и тот же живой адрес (иначе список
        // Replace для этого фасета выведен неверно).
        address oldArbiter = _checkReplaceGroup("ArbiterRegistryFacet", arbiterReplace, diamond);
        address oldRepute  = _checkReplaceGroup("ReputationFacet",      reputeReplace, diamond);

        // Ни один из восьми Add-селекторов не смонтирован нигде на диамонде.
        _checkAddGroup("ArbiterRegistryFacet", arbiterAdd, diamond);
        _checkAddGroup("ReputationFacet",      reputeAdd, diamond);

        uint256 selectorsBefore = _totalRoutedSelectors(diamond);
        console.log("");
        console.log("Total routed selectors BEFORE cut:", selectorsBefore);
        console.log("");

        // ── Апгрейд ───────────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        ArbiterRegistryFacet newArbiter = new ArbiterRegistryFacet();
        ReputationFacet      newRepute  = new ReputationFacet();

        console.log("=== New facet implementations ===");
        console.log("ArbiterRegistryFacet: ", address(newArbiter));
        console.log("ReputationFacet:      ", address(newRepute));
        console.log("");

        IDiamondCut.FacetCut[] memory cuts = buildPaidArbitrationCuts(
            address(newArbiter), address(newRepute)
        );

        // Никакого _init: getArbiterFloor() подставляет дефолт сама, засевать
        // нечего (см. заголовок файла).
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        // ── Post-flight ───────────────────────────────────────────────────
        console.log("=== Post-flight ===");

        _assertRouted("ArbiterRegistryFacet Replace", arbiterReplace, address(newArbiter), diamond);
        _assertRouted("ArbiterRegistryFacet Add",     arbiterAdd,     address(newArbiter), diamond);
        _assertRouted("ReputationFacet Replace",      reputeReplace,  address(newRepute),  diamond);
        _assertRouted("ReputationFacet Add",           reputeAdd,      address(newRepute),  diamond);

        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldArbiter).length == 0, "post: old ArbiterRegistryFacet still holds selectors");
        require(IDiamondLoupe(diamond).facetFunctionSelectors(oldRepute).length == 0,  "post: old ReputationFacet still holds selectors");
        console.log("Both old facet addresses hold zero selectors (fully displaced).");
        console.log("");

        uint256 selectorsAfter = _totalRoutedSelectors(diamond);
        require(selectorsAfter == selectorsBefore + 8, "post: expected exactly +8 routed selectors after the cut");
        console.log("Total routed selectors AFTER cut: ", selectorsAfter);
        console.log("");

        uint256 floor = ArbiterRegistryFacet(diamond).getArbiterFloor();
        console.log("getArbiterFloor():", floor, "(expect 10000000 - 10 USDC default, field unseeded)");
        require(floor == 10_000_000, "post: getArbiterFloor() did not return the unseeded default");

        // getUnresolvedDisputes() должен быть вызываемым и вернуть 0 для
        // адреса без истории споров без вердикта - подтверждает, что
        // селектор реально ведёт в новый ReputationFacet, а не просто
        // числится смонтированным.
        uint256 unresolved = ReputationFacet(diamond).getUnresolvedDisputes(broadcaster);
        console.log("getUnresolvedDisputes(broadcaster):", unresolved);
        console.log("");

        console.log("=== Paid arbitration live on chain ===");
        console.log("Any dispute party can call fundDispute(agreement) to top up the arbiter's");
        console.log("cut to the floor (default 10 USDC); withdrawDisputeBounty() pulls a soft");
        console.log("refund if the push-refund failed (e.g. blacklisted USDC recipient).");
        console.log("");

        console.log("=== Rollback ===");
        console.log("One diamondCut: Replace each of the two groups above back onto <old*>, PLUS");
        console.log("Remove (action 2, facetAddress MUST be address(0) - see DiamondProxy.sol:194)");
        console.log("of the 8 Add selectors, in the SAME cut.");
        console.log("");
        console.log("NEVER Replace the 8 Add selectors onto an old facet. That cut does NOT");
        console.log("revert - replaceFunctions only checks the target facet is a DIFFERENT");
        console.log("address that has SOME code, never that it implements the selector. It");
        console.log("succeeds, loupe reports the selector mounted, and every call to it reverts");
        console.log("with empty returndata. Silent and invisible to facet-level monitoring.");
        console.log("Remove is the only correct action for them.");
        console.log("  <old ArbiterRegistryFacet> =", oldArbiter);
        console.log("  <old ReputationFacet>      =", oldRepute);
    }

    // ════════════════════════════════════════════════════════════════════
    // Pre/post-flight helpers (same shape as script/UpgradeFeeModel.s.sol)
    // ════════════════════════════════════════════════════════════════════

    /// Проверяет, что каждый селектор группы смонтирован (иначе Replace
    /// ревертит "selector not exist" в DiamondCutLib.replaceFunctions), и что
    /// все они указывают на ОДИН и тот же текущий адрес — если это не так,
    /// список Replace для этого фасета выведен неверно (например, часть
    /// функций уже переехала на другой фасет). Возвращает этот адрес.
    function _checkReplaceGroup(string memory label, bytes4[] memory sels, address diamond)
        internal view returns (address facetAddr)
    {
        require(sels.length > 0, string.concat(label, ": replace group is empty"));
        facetAddr = IDiamondLoupe(diamond).facetAddress(sels[0]);
        require(facetAddr != address(0), string.concat(label, ": selector[0] is not mounted at all"));
        for (uint256 i = 0; i < sels.length; i++) {
            address a = IDiamondLoupe(diamond).facetAddress(sels[i]);
            require(a != address(0), string.concat(label, ": a replace selector is not mounted"));
            require(a == facetAddr, string.concat(label, ": replace selectors are split across more than one live facet address"));
        }
        console.log(string.concat(label, " currently mounted at:"), facetAddr);
        console.log(string.concat(label, " selectors to Replace:"), sels.length);
    }

    /// Проверяет, что ни один селектор группы ещё не смонтирован — иначе Add
    /// ревертит "selector exists" в DiamondCutLib.addFunctions.
    function _checkAddGroup(string memory label, bytes4[] memory sels, address diamond) internal view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == address(0),
                string.concat(label, ": an Add selector is already mounted somewhere - Add would revert")
            );
        }
        console.log(string.concat(label, " selectors to Add (currently unmounted):"), sels.length);
    }

    function _assertRouted(string memory label, bytes4[] memory sels, address expected, address diamond) internal view {
        for (uint256 i = 0; i < sels.length; i++) {
            require(
                IDiamondLoupe(diamond).facetAddress(sels[i]) == expected,
                string.concat(label, ": a selector did not land on the new facet")
            );
        }
        console.log(string.concat(label, " -> "), expected);
    }

    function _totalRoutedSelectors(address diamond) internal view returns (uint256 total) {
        IDiamondLoupe.Facet[] memory all = IDiamondLoupe(diamond).facets();
        for (uint256 i = 0; i < all.length; i++) total += all[i].functionSelectors.length;
    }

    // ════════════════════════════════════════════════════════════════════
    // FacetCut[] builder — вынесено в public pure, чтобы
    // test/UpgradePaidArbitrationSelectors.t.sol мог сверить выход с живыми
    // ABI без повторного запуска скрипта. run() выше строит cuts ровно через
    // эту функцию, ничего не дублирует руками.
    // ════════════════════════════════════════════════════════════════════

    function buildPaidArbitrationCuts(address arbiterAddr, address reputeAddr)
        public pure returns (IDiamondCut.FacetCut[] memory cuts)
    {
        cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = _cut(arbiterAddr, IDiamondCut.FacetCutAction.Replace, arbiterRegistryFacetReplaceSelectors());
        cuts[1] = _cut(arbiterAddr, IDiamondCut.FacetCutAction.Add,     arbiterRegistryFacetAddSelectors());
        cuts[2] = _cut(reputeAddr,  IDiamondCut.FacetCutAction.Replace, reputationFacetReplaceSelectors());
        cuts[3] = _cut(reputeAddr,  IDiamondCut.FacetCutAction.Add,     reputationFacetAddSelectors());
    }

    // ── Per-facet selector arrays (ground truth: `forge inspect <Facet> methodIdentifiers`) ──
    // Split Replace (already on chain today, after UpgradeFeeModel for
    // ArbiterRegistryFacet) vs. Add (the 8 new selectors from Tasks 1-4 of
    // the paid-arbitration plan).

    // ArbiterRegistryFacet — 47 Replace (unchanged signatures, incl. the
    // retired-but-mounted setRewardPerDispute/getRewardPerDispute pair —
    // see file header) + 7 Add (paid arbiter call: floor, quote, fund, refund)
    function arbiterRegistryFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](47);
        sels[0]  = ArbiterRegistryFacet.activateDAO.selector;
        sels[1]  = ArbiterRegistryFacet.applyAsArbiter.selector;
        sels[2]  = ArbiterRegistryFacet.resignAsArbiter.selector;
        sels[3]  = ArbiterRegistryFacet.setChiefArbiter.selector;
        sels[4]  = ArbiterRegistryFacet.addArbiter.selector;
        sels[5]  = ArbiterRegistryFacet.removeArbiter.selector;
        sels[6]  = ArbiterRegistryFacet.commitDisputeClaim.selector;
        sels[7]  = ArbiterRegistryFacet.claimDispute.selector;
        sels[8]  = ArbiterRegistryFacet.releaseDisputeClaim.selector;
        sels[9]  = ArbiterRegistryFacet.clearDisputeClaim.selector;
        sels[10] = ArbiterRegistryFacet.submitVerdict.selector;
        sels[11] = ArbiterRegistryFacet.finalizeVerdict.selector;
        sels[12] = ArbiterRegistryFacet.overturnVerdict.selector;
        sels[13] = ArbiterRegistryFacet.notifyArbiterTimeout.selector;
        sels[14] = ArbiterRegistryFacet.freezeVerdict.selector;
        sels[15] = ArbiterRegistryFacet.unfreezeVerdict.selector;
        sels[16] = ArbiterRegistryFacet.clearStuckVerdict.selector;
        sels[17] = ArbiterRegistryFacet.raiseAppeal.selector;
        sels[18] = ArbiterRegistryFacet.voteOnAppeal.selector;
        sels[19] = ArbiterRegistryFacet.resolveAppeal.selector;
        sels[20] = ArbiterRegistryFacet.withdrawArbiterReward.selector;
        sels[21] = ArbiterRegistryFacet.fundVault.selector;
        sels[22] = ArbiterRegistryFacet.setRewardPerDispute.selector; // retired: reverts RewardPathRetired, still mounted (see file header)
        sels[23] = ArbiterRegistryFacet.setDAOAddress.selector;
        sels[24] = ArbiterRegistryFacet.isDaoActive.selector;
        sels[25] = ArbiterRegistryFacet.getMinXPToRegister.selector;
        sels[26] = ArbiterRegistryFacet.getDaoThreshold.selector;
        sels[27] = ArbiterRegistryFacet.getChiefArbiter.selector;
        sels[28] = ArbiterRegistryFacet.isRegisteredArbiter.selector;
        sels[29] = ArbiterRegistryFacet.getArbiters.selector;
        sels[30] = ArbiterRegistryFacet.getDisputeClaimer.selector;
        sels[31] = ArbiterRegistryFacet.getArbiterDeals.selector;
        sels[32] = ArbiterRegistryFacet.getClaimCommitment.selector;
        sels[33] = ArbiterRegistryFacet.getPendingVerdict.selector;
        sels[34] = ArbiterRegistryFacet.getArbiterReward.selector;
        sels[35] = ArbiterRegistryFacet.getVaultBalance.selector;
        sels[36] = ArbiterRegistryFacet.getRewardPerDispute.selector; // retired: always reads 0, still mounted (see file header)
        sels[37] = ArbiterRegistryFacet.getDAOAddress.selector;
        sels[38] = ArbiterRegistryFacet.getArbiterMistakeStreak.selector;
        sels[39] = ArbiterRegistryFacet.hasSubmittedVerdict.selector;
        sels[40] = ArbiterRegistryFacet.getAppealVotes.selector;
        sels[41] = ArbiterRegistryFacet.hasVotedOnAppeal.selector;
        sels[42] = ArbiterRegistryFacet.getArbiterBond.selector;
        sels[43] = ArbiterRegistryFacet.getOpenClaimCount.selector;
        sels[44] = ArbiterRegistryFacet.creditDisputeFee.selector;
        sels[45] = ArbiterRegistryFacet.withdrawTreasurySlice.selector;
        sels[46] = ArbiterRegistryFacet.getTreasurySlice.selector;
    }

    function arbiterRegistryFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](7);
        sels[0] = ArbiterRegistryFacet.setArbiterFloor.selector;
        sels[1] = ArbiterRegistryFacet.fundDispute.selector;
        sels[2] = ArbiterRegistryFacet.getDisputeBounty.selector;
        sels[3] = ArbiterRegistryFacet.withdrawDisputeBounty.selector;
        sels[4] = ArbiterRegistryFacet.getRefundableBounty.selector;
        sels[5] = ArbiterRegistryFacet.getArbiterFloor.selector;
        sels[6] = ArbiterRegistryFacet.quoteDisputeTopUp.selector;
    }

    // ReputationFacet — 8 Replace (unchanged) + 1 Add (unresolved-dispute counter)
    function reputationFacetReplaceSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](8);
        sels[0] = ReputationFacet.autoAwardXP.selector;
        sels[1] = ReputationFacet.claimXP.selector;
        sels[2] = ReputationFacet.notifyExecutorFault.selector;
        sels[3] = ReputationFacet.getXP.selector;
        sels[4] = ReputationFacet.getUniqueActiveUsers.selector;
        sels[5] = ReputationFacet.hasClaimed.selector;
        sels[6] = ReputationFacet.isDealWin.selector;
        sels[7] = ReputationFacet.getCleanStreak.selector;
    }

    function reputationFacetAddSelectors() public pure returns (bytes4[] memory sels) {
        sels = new bytes4[](1);
        sels[0] = ReputationFacet.getUnresolvedDisputes.selector;
    }

    function _cut(address facet, IDiamondCut.FacetCutAction action, bytes4[] memory sels)
        internal pure returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({ facetAddress: facet, action: action, functionSelectors: sels });
    }
}
