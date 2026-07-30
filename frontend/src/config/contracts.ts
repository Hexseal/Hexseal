// Diamond Proxy ABI - основные функции для фронтенда
export const DIAMOND_ABI = [
  // === RegistryFacet ===
  {
    inputs: [
      { internalType: 'address', name: 'client', type: 'address' },
      { internalType: 'address', name: 'executor', type: 'address' },
    ],
    name: 'hasActivePair',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'client', type: 'address' },
      { internalType: 'address', name: 'executor', type: 'address' },
    ],
    name: 'getActivePair',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getRecord',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'agreement', type: 'address' },
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'resolvedAt', type: 'uint256' },
        ],
        internalType: 'struct RegistryStorage.AgreementRecord',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'client', type: 'address' }],
    name: 'getByClient',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'agreement', type: 'address' },
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'resolvedAt', type: 'uint256' },
        ],
        internalType: 'struct RegistryStorage.AgreementRecord[]',
        name: '',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'executor', type: 'address' }],
    name: 'getByExecutor',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'agreement', type: 'address' },
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'resolvedAt', type: 'uint256' },
        ],
        internalType: 'struct RegistryStorage.AgreementRecord[]',
        name: '',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getActive',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'agreement', type: 'address' },
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'resolvedAt', type: 'uint256' },
        ],
        internalType: 'struct RegistryStorage.AgreementRecord[]',
        name: '',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalAgreements',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getDisputed',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'agreement', type: 'address' },
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'resolvedAt', type: 'uint256' },
        ],
        internalType: 'struct RegistryStorage.AgreementRecord[]',
        name: '',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },

  // === FactoryFacet ===
  {
    inputs: [
      { internalType: 'address', name: 'client', type: 'address' },
      { internalType: 'address', name: 'executor', type: 'address' },
      { internalType: 'address', name: 'arbiter', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'string', name: 'terms', type: 'string' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
    ],
    name: 'deployAgreement',
    outputs: [{ internalType: 'address', name: 'agreementAddress', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'client', type: 'address' },
      { internalType: 'address', name: 'executor', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'string', name: 'terms', type: 'string' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
    ],
    name: 'deployAndFund',
    outputs: [{ internalType: 'address', name: 'agreementAddress', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint8', name: 'region', type: 'uint8' }],
    name: 'getRegionFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getAllFees',
    outputs: [
      { internalType: 'uint256', name: 'cis', type: 'uint256' },
      { internalType: 'uint256', name: 'asia', type: 'uint256' },
      { internalType: 'uint256', name: 'eu', type: 'uint256' },
      { internalType: 'uint256', name: 'us', type: 'uint256' },
      { internalType: 'uint256', name: 'latam', type: 'uint256' },
      { internalType: 'uint256', name: 'ca', type: 'uint256' },
      { internalType: 'uint256', name: 'au', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // --- Модель комиссии (28.07.2026): max(amount * feeBps / 10_000, feeFloor) ---
  {
    inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
    name: 'quoteFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  { inputs: [], name: 'getFeeBps', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'getFeeFloor', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'getMaxPendingRequests', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'getJobFeeHeld',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view', type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'requestId', type: 'uint256' }],
    name: 'getRequestFeeHeld',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view', type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'clientAddr', type: 'address' }],
    name: 'getPendingRequestCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view', type: 'function',
  },
  { inputs: [{ internalType: 'uint256', name: 'newBps', type: 'uint256' }], name: 'setFeeBps', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'uint256', name: 'newFloor', type: 'uint256' }], name: 'setFeeFloor', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'uint256', name: 'newMax', type: 'uint256' }], name: 'setMaxPendingRequests', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'id', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'payer', type: 'address' },
      { indexed: true, internalType: 'uint8', name: 'kind', type: 'uint8' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'FeeCollected',
    type: 'event',
  },
  {
    inputs: [],
    name: 'getUsdc',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getTrustedForwarder',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'newRecipient', type: 'address' }],
    name: 'setFeeRecipient',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'newForwarder', type: 'address' }],
    name: 'setTrustedForwarder',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getFeeRecipient',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint8', name: 'region', type: 'uint8' },
      { internalType: 'uint256', name: 'newFee', type: 'uint256' },
    ],
    name: 'setRegionFee',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },

  // === ServiceBoardFacet ===
  {
    inputs: [
      { internalType: 'string', name: 'title', type: 'string' },
      { internalType: 'string', name: 'description', type: 'string' },
      { internalType: 'uint256', name: 'price', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
    ],
    name: 'mintService',
    outputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'executor', type: 'address' },
      { internalType: 'string', name: 'title', type: 'string' },
      { internalType: 'string', name: 'description', type: 'string' },
      { internalType: 'uint256', name: 'price', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
      { internalType: 'uint256', name: 'permitDeadline', type: 'uint256' },
      { internalType: 'uint8', name: 'v', type: 'uint8' },
      { internalType: 'bytes32', name: 'r', type: 'bytes32' },
      { internalType: 'bytes32', name: 's', type: 'bytes32' },
    ],
    name: 'mintServiceWithPermit',
    outputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'serviceId', type: 'uint256' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'string', name: 'terms', type: 'string' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
    ],
    name: 'requestService',
    outputs: [{ internalType: 'uint256', name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address',  name: 'client',        type: 'address'  },
      { internalType: 'uint256',  name: 'serviceId',     type: 'uint256'  },
      { internalType: 'uint256',  name: 'amount',        type: 'uint256'  },
      { internalType: 'uint256',  name: 'deadlineDays',  type: 'uint256'  },
      { internalType: 'string',  name: 'terms',         type: 'string'   },
      { internalType: 'uint8',    name: 'region',        type: 'uint8'    },
      { internalType: 'uint256',  name: 'permitDeadline', type: 'uint256' },
      { internalType: 'uint8',    name: 'v',             type: 'uint8'    },
      { internalType: 'bytes32',  name: 'r',             type: 'bytes32'  },
      { internalType: 'bytes32',  name: 's',             type: 'bytes32'  },
    ],
    name: 'requestServiceWithPermit',
    outputs: [{ internalType: 'uint256', name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'requestId', type: 'uint256' }],
    name: 'acceptRequest',
    outputs: [{ internalType: 'address', name: 'agreementAddr', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'requestId', type: 'uint256' }],
    name: 'rejectRequest',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'requestId', type: 'uint256' }],
    name: 'cancelRequest',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    name: 'removeService',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    name: 'pauseService',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    name: 'unpauseService',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    name: 'getService',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'string', name: 'title', type: 'string' },
          { internalType: 'string', name: 'description', type: 'string' },
          { internalType: 'uint256', name: 'price', type: 'uint256' },
          { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
          { internalType: 'uint8', name: 'region', type: 'uint8' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'hiresCount', type: 'uint256' },
        ],
        internalType: 'struct ServiceBoardStorage.Service',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'requestId', type: 'uint256' }],
    name: 'getRequest',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'uint256', name: 'serviceId', type: 'uint256' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
          { internalType: 'string', name: 'terms', type: 'string' },
          { internalType: 'uint8', name: 'region', type: 'uint8' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'address', name: 'agreement', type: 'address' },
        ],
        internalType: 'struct ServiceBoardStorage.HireRequest',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'executor', type: 'address' }],
    name: 'getExecutorServices',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'client', type: 'address' }],
    name: 'getClientRequests',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    name: 'getServiceRequests',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalServices',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalRequests',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getActiveServices',
    outputs: [
      { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      {
        components: [
          { internalType: 'address', name: 'executor', type: 'address' },
          { internalType: 'string', name: 'title', type: 'string' },
          { internalType: 'string', name: 'description', type: 'string' },
          { internalType: 'uint256', name: 'price', type: 'uint256' },
          { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
          { internalType: 'uint8', name: 'region', type: 'uint8' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'uint256', name: 'hiresCount', type: 'uint256' },
        ],
        internalType: 'struct ServiceBoardStorage.Service[]',
        name: 'activeServices',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'serviceId', type: 'uint256' }],
    name: 'getPendingRequests',
    outputs: [
      { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      {
        components: [
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'uint256', name: 'serviceId', type: 'uint256' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
          { internalType: 'string', name: 'terms', type: 'string' },
          { internalType: 'uint8', name: 'region', type: 'uint8' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'address', name: 'agreement', type: 'address' },
        ],
        internalType: 'struct ServiceBoardStorage.HireRequest[]',
        name: 'pendingReqs',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },

  // === JobBoardFacet ===
  {
    inputs: [
      { internalType: 'address', name: 'client', type: 'address' },
      { internalType: 'string', name: 'title', type: 'string' },
      { internalType: 'string', name: 'description', type: 'string' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'string', name: 'terms', type: 'string' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
      { internalType: 'uint256', name: 'permitDeadline', type: 'uint256' },
      { internalType: 'uint8', name: 'v', type: 'uint8' },
      { internalType: 'bytes32', name: 'r', type: 'bytes32' },
      { internalType: 'bytes32', name: 's', type: 'bytes32' },
    ],
    name: 'mintJobWithPermit',
    outputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'string',  name: 'title',       type: 'string'  },
      { internalType: 'string',  name: 'description', type: 'string'  },
      { internalType: 'uint256', name: 'amount',       type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'string',  name: 'terms',        type: 'string'  },
      { internalType: 'uint8',   name: 'region',       type: 'uint8'   },
    ],
    name: 'mintJob',
    outputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'applyForJob',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'withdrawApplication',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { internalType: 'address', name: 'executor', type: 'address' },
    ],
    name: 'acceptApplicant',
    outputs: [{ internalType: 'address', name: 'agreementAddr', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'cancelJob',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { internalType: 'string', name: 'title', type: 'string' },
      { internalType: 'string', name: 'description', type: 'string' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'string', name: 'terms', type: 'string' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
    ],
    name: 'editJob',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'serviceId', type: 'uint256' },
      { internalType: 'string', name: 'title', type: 'string' },
      { internalType: 'string', name: 'description', type: 'string' },
      { internalType: 'uint256', name: 'price', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
    ],
    name: 'editService',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'getJob',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'string', name: 'title', type: 'string' },
          { internalType: 'string', name: 'description', type: 'string' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
          { internalType: 'string', name: 'terms', type: 'string' },
          { internalType: 'uint8', name: 'region', type: 'uint8' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'address', name: 'chosenExecutor', type: 'address' },
          { internalType: 'address', name: 'agreement', type: 'address' },
        ],
        internalType: 'struct JobBoardStorage.Job',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getOpenJobs',
    outputs: [
      { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      {
        components: [
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'string', name: 'title', type: 'string' },
          { internalType: 'string', name: 'description', type: 'string' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
          { internalType: 'string', name: 'terms', type: 'string' },
          { internalType: 'uint8', name: 'region', type: 'uint8' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
          { internalType: 'address', name: 'chosenExecutor', type: 'address' },
          { internalType: 'address', name: 'agreement', type: 'address' },
        ],
        internalType: 'struct JobBoardStorage.Job[]',
        name: 'openJobs',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'client', type: 'address' }],
    name: 'getClientJobs',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'getApplicants',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalJobs',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'client', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
      { indexed: false, internalType: 'uint8', name: 'region', type: 'uint8' },
      { indexed: false, internalType: 'string', name: 'title', type: 'string' },
      { indexed: false, internalType: 'string', name: 'description', type: 'string' },
      { indexed: false, internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { indexed: false, internalType: 'string', name: 'terms', type: 'string' },
    ],
    name: 'JobPosted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'executor', type: 'address' },
    ],
    name: 'JobApplied',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'client', type: 'address' },
      { indexed: true, internalType: 'address', name: 'executor', type: 'address' },
      { indexed: false, internalType: 'address', name: 'agreement', type: 'address' },
    ],
    name: 'JobAccepted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'client', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'refundAmount', type: 'uint256' },
    ],
    name: 'JobCancelled',
    type: 'event',
  },

  // === OwnershipFacet ===
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },

  // === DiamondLoupeFacet ===
  {
    inputs: [],
    name: 'facets',
    outputs: [
      {
        components: [
          { internalType: 'address', name: 'facetAddress', type: 'address' },
          { internalType: 'bytes4[]', name: 'functionSelectors', type: 'bytes4[]' },
        ],
        internalType: 'struct IDiamondLoupe.Facet[]',
        name: 'facets_',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },

  // === Events ===
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: true, internalType: 'address', name: 'client', type: 'address' },
      { indexed: true, internalType: 'address', name: 'executor', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'AgreementRegistered',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: true, internalType: 'address', name: 'client', type: 'address' },
      { indexed: true, internalType: 'address', name: 'executor', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
      { indexed: false, internalType: 'uint8', name: 'region', type: 'uint8' },
      { indexed: false, internalType: 'uint256', name: 'fee', type: 'uint256' },
    ],
    name: 'AgreementDeployed',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: false, internalType: 'uint8', name: 'newStatus', type: 'uint8' },
    ],
    name: 'AgreementStatusUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'arbiter', type: 'address' },
    ],
    name: 'ProtocolArbiterUpdated',
    type: 'event',
  },
];

// ServiceBoardFacet events (all on Diamond address)
export const SERVICE_BOARD_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256', name: 'serviceId', type: 'uint256' },
      { indexed: true,  internalType: 'address', name: 'executor',  type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'price',     type: 'uint256' },
      { indexed: false, internalType: 'uint8',   name: 'region',    type: 'uint8'   },
      { indexed: false, internalType: 'string',  name: 'title',     type: 'string'  },
      { indexed: false, internalType: 'string',  name: 'description', type: 'string' },
      { indexed: false, internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
    ],
    name: 'ServicePosted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256', name: 'requestId', type: 'uint256' },
      { indexed: true,  internalType: 'uint256', name: 'serviceId', type: 'uint256' },
      { indexed: true,  internalType: 'address', name: 'client',    type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount',    type: 'uint256' },
    ],
    name: 'ServiceRequested',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256', name: 'requestId', type: 'uint256' },
      { indexed: true,  internalType: 'address', name: 'executor',  type: 'address' },
      { indexed: true,  internalType: 'address', name: 'client',    type: 'address' },
      { indexed: false, internalType: 'address', name: 'agreement', type: 'address' },
    ],
    name: 'RequestAccepted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'requestId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'executor',  type: 'address' },
      { indexed: true, internalType: 'address', name: 'client',    type: 'address' },
    ],
    name: 'RequestRejected',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'requestId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'client',    type: 'address' },
    ],
    name: 'RequestCancelled',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'serviceId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'executor',  type: 'address' },
    ],
    name: 'ServiceRemoved',
    type: 'event',
  },
] as const;

// USDC ABI (минимальный)
export const USDC_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'nonces',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'owner', type: 'address' },
      { indexed: true, internalType: 'address', name: 'spender', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'value', type: 'uint256' },
    ],
    name: 'Approval',
    type: 'event',
  },
];

// MinimalForwarder ABI
export const FORWARDER_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'from', type: 'address' }],
    name: 'getNonce',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'from', type: 'address' },
          { internalType: 'address', name: 'to', type: 'address' },
          { internalType: 'uint256', name: 'value', type: 'uint256' },
          { internalType: 'uint256', name: 'gas', type: 'uint256' },
          { internalType: 'uint256', name: 'nonce', type: 'uint256' },
          { internalType: 'bytes', name: 'data', type: 'bytes' },
        ],
        internalType: 'struct MinimalForwarder.ForwardRequest',
        name: 'req',
        type: 'tuple',
      },
      { internalType: 'bytes', name: 'signature', type: 'bytes' },
    ],
    name: 'execute',
    outputs: [
      { internalType: 'bool', name: 'success', type: 'bool' },
      { internalType: 'bytes', name: 'retdata', type: 'bytes' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'from', type: 'address' },
          { internalType: 'address', name: 'to', type: 'address' },
          { internalType: 'uint256', name: 'value', type: 'uint256' },
          { internalType: 'uint256', name: 'gas', type: 'uint256' },
          { internalType: 'uint256', name: 'nonce', type: 'uint256' },
          { internalType: 'bytes', name: 'data', type: 'bytes' },
        ],
        internalType: 'struct MinimalForwarder.ForwardRequest',
        name: 'req',
        type: 'tuple',
      },
      { internalType: 'bytes', name: 'signature', type: 'bytes' },
    ],
    name: 'verify',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// Единственный признак, отличающий дележ котла от настоящего возврата: реестр в
// обоих случаях получает REFUNDED, потому что перечисление статусов расширять
// нельзя — оно повторяет `enum Status` агримента, чья раскладка заморожена.
// Суммы здесь ФАКТИЧЕСКИ переведённые, а не расчётные: если USDC заблокировал
// исполнителя, контракт отдаёт его половину клиенту, и событие покажет ноль.
// Вынесено отдельным `as const`, потому что `AGREEMENT_ABI` целиком не const, а
// `parseEventLogs` без него не выведет типы аргументов (см. `lib/settledRefund`).
export const DISPUTE_SPLIT_EVENT = {
  anonymous: false,
  inputs: [
    { indexed: false, internalType: 'uint256', name: 'toClient',   type: 'uint256' },
    { indexed: false, internalType: 'uint256', name: 'toExecutor', type: 'uint256' },
  ],
  name: 'DisputeSplitNoVerdict',
  type: 'event',
} as const;

// Явка в споре: если за DISPUTE_WINDOW арбитр так и не взялся за дело, тот, кто
// откликнулся (respondToDispute), получает 3/4 котла, а промолчавший — 1/4.
// Вынесено отдельным `as const` по той же причине, что и DISPUTE_SPLIT_EVENT
// выше: `AGREEMENT_ABI` целиком не const, и без этого `parseEventLogs` не
// выведет типы аргументов. Разбирает его `findUnansweredInLogs`
// (`lib/settledRefund`) — суммы там по РОЛЯМ в споре, а не по сторонам сделки,
// поэтому в стороны их переводит уже вызывающий, у которого есть адреса.
export const DISPUTE_UNANSWERED_EVENT = {
  anonymous: false,
  inputs: [
    { indexed: true,  internalType: 'address', name: 'responder',   type: 'address' },
    { indexed: false, internalType: 'uint256', name: 'toResponder', type: 'uint256' },
    { indexed: false, internalType: 'uint256', name: 'toSilent',    type: 'uint256' },
  ],
  name: 'DisputeUnanswered',
  type: 'event',
} as const;

// Agreement ABI (для взаимодействия с отдельными Agreement контрактами)
export const AGREEMENT_ABI = [
  {
    inputs: [],
    name: 'status',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'client',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'executor',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'amount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'fundedAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'activatedAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'markedDoneAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'disputedAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'resolvedAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'deadlineDays',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'timeLeft',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'fund',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'activate',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'markDone',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'release',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'triggerAutoApprove',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'raiseDispute',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'respondToDispute',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'clientResponded',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'executorResponded',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bool', name: 'clientWins', type: 'bool' }],
    name: 'resolveDispute',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'triggerActivationTimeout',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'triggerDeadlineTimeout',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'triggerArbiterTimeout',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getDetails',
    outputs: [
      { internalType: 'address', name: 'client_', type: 'address' },
      { internalType: 'address', name: 'executor_', type: 'address' },
      { internalType: 'address', name: 'arbiter_', type: 'address' },
      { internalType: 'uint256', name: 'amount_', type: 'uint256' },
      { internalType: 'string', name: 'terms_', type: 'string' },
      { internalType: 'uint256', name: 'deadlineDays_', type: 'uint256' },
      { internalType: 'uint256', name: 'fundedAt_', type: 'uint256' },
      { internalType: 'uint256', name: 'activatedAt_', type: 'uint256' },
      { internalType: 'uint256', name: 'markedDoneAt_', type: 'uint256' },
      { internalType: 'uint256', name: 'disputedAt_', type: 'uint256' },
      { internalType: 'uint256', name: 'resolvedAt_', type: 'uint256' },
      { internalType: 'uint8',   name: 'status_',     type: 'uint8' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'arbiterTimeLeft',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── Extras ──
  {
    inputs: [
      { internalType: 'uint256', name: 'extraAmount', type: 'uint256' },
      { internalType: 'bytes32', name: 'extraTermsHash', type: 'bytes32' },
    ],
    name: 'proposeExtra',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'extraId', type: 'uint256' }],
    name: 'acceptExtra',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'extraId', type: 'uint256' }],
    name: 'rejectExtra',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'extraId', type: 'uint256' }],
    name: 'getExtra',
    outputs: [
      {
        components: [
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'string', name: 'terms', type: 'string' },
          { internalType: 'uint8',   name: 'status',    type: 'uint8' },
        ],
        internalType: 'struct Agreement.Extra',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalPayout',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'nextExtraId',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'extrasTotal',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Что разбирательство спора возьмёт из котла — 3%, потолок $500. Фронт
  // показывает эту сумму ДО открытия спора (DisputeCostNotice): иначе
  // пользователь узнаёт про сбор только когда деньги пришли меньше ожидаемого.
  //
  // ВАЖНО: этого селектора НЕТ у клонов Agreement, созданных до апгрейда на
  // реализацию со сбором — у них вызов реверта (у Agreement нет fallback).
  // Это не баг, а признак: DisputeCostNotice ничего не рисует, если чтение не
  // удалось, и старая сделка честно остаётся без нового предупреждения, потому
  // что живёт по старым правилам (сбора нет, таймаут без клейма возвращает всё
  // клиенту).
  {
    inputs: [],
    name: 'disputeFee',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Срок, за который спор должен быть разрешён. Читается, а не хардкодится:
  // константа уже менялась однажды с 7 дней на 4, и захардкоженный фронт после
  // следующей правки начал бы врать молча.
  {
    inputs: [],
    name: 'DISPUTE_WINDOW',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  DISPUTE_SPLIT_EVENT,
  DISPUTE_UNANSWERED_EVENT,
];

// Раньше diamond/forwarder/usdc падали обратно на захардкоженный литерал, если
// переменная окружения отсутствовала — то есть два источника правды на один и тот
// же адрес. Именно так словили реальный баг: frontend/.env.local держал старый
// адрес diamond, который молча перебивал уже поправленный хардкод, и фронт бы
// продолжил стучаться в брошенный контракт, при этом выглядя в репозитории
// корректно. NEXT_PUBLIC_* инлайнятся Next.js на этапе билда — значит и упасть
// это должно на билде/старте, а не позже на каком-то клике пользователя.
// Bare `process.env.NEXT_PUBLIC_...` (dot-notation, без переменной вместо имени)
// нужен на каждом вызове отдельно — только так Next.js статически подставляет
// значение в клиентский бандл.
function requiredAddress(value: string | undefined, label: string): `0x${string}` {
  if (!value) {
    throw new Error(
      `${label} is not set. This must come from the environment (see .env.vps.example) — ` +
      `there is no hardcoded fallback on purpose, since a stale one previously masked a ` +
      `real contract-address change.`
    );
  }
  return value as `0x${string}`;
}

// Адреса контрактов
export const CONTRACTS = {
  diamond:   requiredAddress(process.env.NEXT_PUBLIC_DIAMOND_ADDRESS,   'NEXT_PUBLIC_DIAMOND_ADDRESS'),
  forwarder: requiredAddress(process.env.NEXT_PUBLIC_FORWARDER_ADDRESS, 'NEXT_PUBLIC_FORWARDER_ADDRESS'),
  usdc:      requiredAddress(process.env.NEXT_PUBLIC_USDC_ADDRESS,      'NEXT_PUBLIC_USDC_ADDRESS'),
  // Легаси: отдельный "PlatformReceiptNFT" не задеплоен и нигде в коде не используется
  // (JobReceiptFacet — это фасет диамонда, адрес приходит через CONTRACTS.diamond).
  // NEXT_PUBLIC_JOB_RECEIPT_ADDRESS нет ни в одном .env — намеренно оставлен мягким
  // fallback'ом на нулевой адрес, а не requiredAddress(), чтобы не ронять билд ради
  // мёртвого поля.
  jobReceipt: (process.env.NEXT_PUBLIC_JOB_RECEIPT_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
} as const;

// PlatformReceiptNFT ABI — standalone contract, не Diamond facet
// Обрабатывает чеки для JOB (зелёные) и OFFER (фиолетовые)
export const JOB_RECEIPT_NFT_ABI = [
  // ── Views ──
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'jobClaimed',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'offerId', type: 'uint256' }],
    name: 'offerClaimed',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenReceiptType',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── Fallback claim (если авто-минт не сработал) ──
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'claimReceipt',
    outputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // ── Event ──
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'uint256', name: 'tokenId',     type: 'uint256' },
      { indexed: false, internalType: 'uint8',   name: 'receiptType', type: 'uint8'   },
      { indexed: true,  internalType: 'uint256', name: 'refId',       type: 'uint256' },
      { indexed: true,  internalType: 'address', name: 'owner',       type: 'address' },
    ],
    name: 'ReceiptMinted',
    type: 'event',
  },
] as const;

// Регионы (больше не влияют на комиссию — только процент + пол от суммы сделки)
export const REGIONS = {
  CIS: 0,
  ASIA: 1,
  EU: 2,
  US: 3,
  LATAM: 4,
  CA: 5,
  AU: 6,
} as const;

// Статусы сделок
export const AGREEMENT_STATUS = {
  ACTIVE: 0,
  COMPLETED: 1,
  REFUNDED: 2,
  DISPUTED: 3,
  RESOLVED: 4,
} as const;

export const STATUS_LABELS: Record<number, string> = {
  0: 'Active',
  1: 'Completed',
  2: 'Refunded',
  3: 'Disputed',
  4: 'Resolved',
};

// JobReceiptFacet ABI (part of Diamond) — replaces OfferNFTFacet
export const JOB_RECEIPT_FACET_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
      { internalType: 'uint8', name: 'region', type: 'uint8' },
      { internalType: 'string', name: 'title', type: 'string' },
    ],
    name: 'mintJobReceipt',
    outputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'getJobReceiptData',
    outputs: [
      {
        internalType: 'struct ReceiptStorage.JobReceiptData',
        name: '',
        type: 'tuple',
        components: [
          { internalType: 'address', name: 'client', type: 'address' },
          { internalType: 'string', name: 'title', type: 'string' },
          { internalType: 'uint256', name: 'amount', type: 'uint256' },
          { internalType: 'uint256', name: 'deadlineDays', type: 'uint256' },
          { internalType: 'uint8', name: 'region', type: 'uint8' },
          { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'isJobReceiptToken',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getReceiptTotalSupply',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'renderer', type: 'address' }],
    name: 'setSvgRenderer',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSvgRenderer',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'name',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'owner', type: 'address' },
      { indexed: true, internalType: 'address', name: 'approved', type: 'address' },
      { indexed: true, internalType: 'uint256', name: 'tokenId', type: 'uint256' },
    ],
    name: 'Approval',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'owner', type: 'address' },
      { indexed: true, internalType: 'address', name: 'operator', type: 'address' },
      { indexed: false, internalType: 'bool', name: 'approved', type: 'bool' },
    ],
    name: 'ApprovalForAll',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      { indexed: true, internalType: 'uint256', name: 'tokenId', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'tokenId', type: 'uint256' },
      { indexed: true, internalType: 'uint256', name: 'jobId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'client', type: 'address' },
    ],
    name: 'JobReceiptBurned',
    type: 'event',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'burnJobReceipt',
    outputs: [{ internalType: 'bool', name: 'burned', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'isJobReceiptBurned',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'jobId', type: 'uint256' }],
    name: 'getTokenIdByJobId',
    outputs: [
      { internalType: 'uint256', name: 'tokenId', type: 'uint256' },
      { internalType: 'bool', name: 'exists', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// ArbiterRegistryFacet ABI (part of Diamond)
export const ARBITER_REGISTRY_ABI = [
  // Admin
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'setChiefArbiter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'addArbiter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'removeArbiter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Arbiter actions
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'claimDispute',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'releaseDisputeClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Views
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'isRegisteredArbiter',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getChiefArbiter',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getArbiters',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getDisputeClaimer',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getArbiterDeals',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'commitment', type: 'bytes32' }],
    name: 'commitDisputeClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'commitment', type: 'bytes32' }],
    name: 'getClaimCommitment',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Events
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'ArbiterAdded',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'ArbiterRemoved',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: true, internalType: 'address', name: 'arbiter', type: 'address' },
    ],
    name: 'DisputeClaimed',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: true, internalType: 'address', name: 'prevArbiter', type: 'address' },
    ],
    name: 'DisputeReleased',
    type: 'event',
  },
  // DAO mode
  {
    inputs: [],
    name: 'activateDAO',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'applyAsArbiter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'isDaoActive',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getMinXPToRegister',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getDaoThreshold',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // V3 — verdict flow
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }, { internalType: 'bool', name: 'clientWins', type: 'bool' }],
    name: 'submitVerdict',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'finalizeVerdict',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }, { internalType: 'bool', name: 'newClientWins', type: 'bool' }],
    name: 'overturnVerdict',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'freezeVerdict',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'unfreezeVerdict',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // V3 — rewards
  {
    inputs: [],
    name: 'withdrawArbiterReward',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
    name: 'fundVault',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
    name: 'setRewardPerDispute',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'dao', type: 'address' }],
    name: 'setDAOAddress',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // V3 — views
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getPendingVerdict',
    outputs: [{
      components: [
        { internalType: 'address', name: 'arbiter',     type: 'address' },
        { internalType: 'bool',    name: 'clientWins',  type: 'bool' },
        { internalType: 'uint256', name: 'submittedAt', type: 'uint256' },
        { internalType: 'bool',    name: 'frozen',      type: 'bool' },
        { internalType: 'bool',    name: 'finalized',   type: 'bool' },
        { internalType: 'bool',    name: 'overturned',  type: 'bool' },
      ],
      internalType: 'struct ArbiterRegistryStorage.PendingVerdict',
      name: '',
      type: 'tuple',
    }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getArbiterReward',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getVaultBalance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getRewardPerDispute',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getDAOAddress',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'clearStuckVerdict',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // V3 — events
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'agreement',  type: 'address' },
      { indexed: true,  internalType: 'address', name: 'arbiter',    type: 'address' },
      { indexed: false, internalType: 'bool',    name: 'clientWins', type: 'bool' },
    ],
    name: 'VerdictSubmitted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'agreement', type: 'address' },
    ],
    name: 'VerdictFinalized',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount',  type: 'uint256' },
    ],
    name: 'ArbiterRewarded',
    type: 'event',
  },
] as const;

export const REPUTATION_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'claimXP',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'getXP',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getUniqueActiveUsers',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'agreement', type: 'address' },
      { internalType: 'address', name: 'claimant', type: 'address' },
    ],
    name: 'hasClaimed',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'isDealWin',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'getCleanStreak',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: true, internalType: 'address', name: 'claimant', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'xpGained', type: 'uint256' },
    ],
    name: 'XPClaimed',
    type: 'event',
  },
] as const;
