# archive/

Одноразовые скрипты апгрейда — каждый выполнен ровно один раз (`diamondCut` /
деплой на Base Sepolia), результат сверен чтением с цепи, и повторный запуск
никому не нужен. Актуальные, живые скрипты — уровнем выше, в `script/`
(`DeployFull.s.sol`, `DeployForwarder.s.sol`, `DeployTreasury.s.sol`,
`UpdateKeys.s.sol`, `UpdateForwarder.s.sol`, `CheckDiamondSelectors.s.sol`,
`RemoveOldFacets.s.sol`).

Хранятся, а не удалены: история апгрейдов диамонда — часть учёта, некоторые из
них хардкодят уже выведенные из эксплуатации адреса, и это ценно как запись,
что где стояло. Три файла здесь импортируются тестами как gate против дрейфа
(`test/UpgradeFeeModelSelectors.t.sol`, `test/UpgradePaidArbitrationSelectors.t.sol`,
`test/ArbiterChatKeyUpgrade.t.sol`) — их не трогать без правки соответствующего
теста.
