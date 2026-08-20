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
    type: "function",
    name: "claimDispute",
    inputs: [
      { name: "agreement", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "boxKey", type: "bytes32" },
      { name: "signKey", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
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
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getArbiterChatKeys',
    outputs: [
      { internalType: 'bytes32', name: 'boxKey', type: 'bytes32' },
      { internalType: 'bytes32', name: 'signKey', type: 'bytes32' },
    ],
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
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'arbiter', type: 'address' },
      { indexed: false, internalType: 'bytes32', name: 'boxKey', type: 'bytes32' },
      { indexed: false, internalType: 'bytes32', name: 'signKey', type: 'bytes32' },
    ],
    name: 'ArbiterChatKeySet',
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
  // V4 — платный вызов арбитра
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'quoteDisputeTopUp',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'fundDispute',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getDisputeBounty',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'who', type: 'address' }],
    name: 'getRefundableBounty',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'withdrawDisputeBounty',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getArbiterFloor',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── 4в-2 Выкатка 2: запись «просил, ответа нет» и отпечаток предъявления ──
  //
  // Восемь входов, приехавших разрезом script/UpgradePresentationRecord.s.sol
  // (ArbiterRegistryFacet, 14 августа 2026). Типы взяты из исходника фасета, а не
  // по памяти, и сверяются с ним замком lib/presentationDigestAbi.test.ts —
  // включая ИМЕНА аргументов: у getPresentationDigestsPage два подряд uint256,
  // перестановка которых по типам невидима.
  //
  // ⚠️ Пол записи о молчании здесь СВОИМ ЧИСЛОМ не лежит и лежать не должен:
  // спрашивается у цепи через getNoResponseFloor (hooks/useNoResponseFloor.ts).
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getDisputeClaimedAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'recordNoResponse',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getNoResponseAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getNoResponseFloor',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    // `pure`, а не `view`: число — константа контракта. Изменчивость сверяется
    // замком, потому что от неё зависит, соберётся ли крючок чтения (wagmi
    // useReadContract принимает только pure/view).
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'agreement', type: 'address' },
      { internalType: 'bytes32', name: 'digest', type: 'bytes32' },
    ],
    name: 'recordPresentationDigest',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getPresentationDigests',
    outputs: [{ internalType: 'bytes32[]', name: '', type: 'bytes32[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'agreement', type: 'address' },
      { internalType: 'uint256', name: 'offset', type: 'uint256' },
      { internalType: 'uint256', name: 'limit', type: 'uint256' },
    ],
    name: 'getPresentationDigestsPage',
    outputs: [{ internalType: 'bytes32[]', name: '', type: 'bytes32[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getPresentationDigestCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── 4в-2 Выкатка 2: лента ────────────────────────────────────────────────
  //
  // ⚠️ ЭТО НЕ ДУБЛЬ ГЕТТЕРОВ ВЫШЕ. Геттеры отвечают «сколько и какие», а спор
  // решается вопросом «что было раньше»: отпечаток лёг на блоке N, запись
  // арбитра «просил, ответа нет» — на блоке M. Номера блока у геттеров нет ни
  // у одного, порядок берётся только из ленты. Плюс хранилище показывает
  // запись ТЕКУЩЕГО клеймера, а по апелляции смотрят весь ход спора, включая
  // арбитров, которые спор уже отпустили, — их видно только здесь.
  //
  // ⚠️ Флаги `indexed` сверяются с исходником замком наравне с типами: они
  // решают, что уедет в topics, а что в data. Ошибка в них не ревертит ничего —
  // фильтр по сделке молча не находит НИЧЕГО.
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: true,  internalType: 'address', name: 'arbiter',   type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'at',        type: 'uint256' },
    ],
    name: 'DisputeNoResponseRecorded',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'agreement', type: 'address' },
      { indexed: true,  internalType: 'address', name: 'submitter', type: 'address' },
      { indexed: false, internalType: 'bytes32', name: 'digest',    type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'index',     type: 'uint256' },
    ],
    name: 'PresentationDigestRecorded',
    type: 'event',
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

/**
 * ArbiterAccountabilityFacet — второй арбитражный фасет даймонда.
 *
 * ⚠️ ЗАЧЕМ ОТДЕЛЬНАЯ ЗАПИСЬ, ЕСЛИ АДРЕС ТОТ ЖЕ. Адрес действительно один —
 * `CONTRACTS.diamond`, и какой фасет отвечает за селектор, снаружи не видно.
 * Дело не в маршрутизации, а в РАСШИФРОВКЕ ОТКАЗА: прямая транзакция (не
 * гейслесс) разбирает revert по ABI, которое ей дали, а не по таблице причин
 * релеера. Ошибки, объявленной в этом ABI, viem не найдёт — и человек увидит
 * сырой хекс ровно там, где ему надо объяснить, почему кнопка не сработала.
 * До 17 августа 2026 фронт не знал об этом фасете вовсе.
 *
 * ⚠️ ПОЧЕМУ СТАРЫЕ `removeArbiter` И `ArbiterRemoved` ОСТАЛИСЬ В
 * ARBITER_REGISTRY_ABI ВЫШЕ. Голая `removeArbiter(address)` удалена из
 * исходника, но в живом даймонде она смонтирована и работает до разреза
 * `script/UpgradeArbiterAccountability.s.sol`. Убрать её из ABI сейчас — сломать
 * работающие сегодня кнопки. Уберётся вместе с ними, когда владелец решит, чем
 * их заменить.
 *
 * ⚠️ ПЕРЕСЕЧЕНИЕ С ARBITER_REGISTRY_ABI — НАМЕРЕННОЕ. Восемь чтений
 * (`getArbiterReward`, `getArbiterDeals`, `getArbiterChatKeys`,
 * `getDisputeClaimedAt`, `getNoResponseAt`, `getPresentationDigests`,
 * `getPresentationDigestsPage`, `getPresentationDigestCount`) уехали сюда
 * коммитом a88a2200, но записи в ARBITER_REGISTRY_ABI не убраны: по ним ходит
 * живой код, а даймонд отвечает по обеим записям одинаково. Расходиться этим
 * двум спискам не даёт замок `lib/arbiterAccountabilityAbi.test.ts` — оба
 * сверяются с исходником, а не друг с другом.
 *
 * Состав — 34 функции и 9 событий, сверяется с
 * `src/facets/ArbiterAccountabilityFacet.sol` тем же замком: типы, ИМЕНА
 * аргументов и возвратов, изменчивость и флаги `indexed`.
 *
 * `Cause` — enum контракта, в ABI это `uint8`:
 *   0 OverturnedVerdicts · 1 Timeouts · 2 Silence — проверяются цепью,
 *   3 Collusion · 4 Leak · 5 Other — только заверяются отпечатком.
 */
export const ARBITER_ACCOUNTABILITY_ABI = [
  // ── Приостановка ─────────────────────────────────────────────────────────
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'suspendArbiter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'liftSuspension',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'isSuspended',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getSuspendedUntil',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSuspensionWindow',
    // `pure`, не `view`: число — константа контракта. Изменчивость сверяется
    // замком, потому что от неё зависит, соберётся ли крючок чтения (wagmi
    // useReadContract принимает только pure/view).
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  // ── Снос по поводу ───────────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'address', name: 'arbiter', type: 'address' },
      { internalType: 'enum ArbiterAccountabilityFacet.Cause', name: 'cause', type: 'uint8' },
      { internalType: 'bytes32', name: 'evidenceDigest', type: 'bytes32' },
      { internalType: 'address', name: 'disputeRef', type: 'address' },
      // Слова обвинителя. ОБЯЗАТЕЛЬНЫ ровно там, где цепь молчит: коды 3-5
      // (Collusion/Leak/Other) она не проверяет, а только заверяет отпечатком,
      // и пустой `reason` там отвергается (`ReasonRequired`). Потолок — 512
      // БАЙТ, не символов, и спрашивается у цепи через `getMaxReasonBytes()`:
      // счётчик «осталось N символов» соврёт вчетверо на первом же эмодзи.
      { internalType: 'string', name: 'reason', type: 'string' },
    ],
    name: 'removeArbiterForCause',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getMistakeThreshold',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getMaxArbiterMistakesMirror',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getDaoThresholdMirror',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  // ── Предложение директора ────────────────────────────────────────────────
  {
    inputs: [
      { internalType: 'address', name: 'arbiter', type: 'address' },
      { internalType: 'enum ArbiterAccountabilityFacet.Cause', name: 'cause', type: 'uint8' },
      { internalType: 'bytes32', name: 'evidenceDigest', type: 'bytes32' },
      // То же правило и тот же потолок, что у removeArbiterForCause выше:
      // обвинение, которое цепь не проверяет сама, обязано объясняться словами.
      { internalType: 'string', name: 'reason', type: 'string' },
    ],
    name: 'proposeRemoval',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'withdrawProposal',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // ── Тихая дверь заводится в общую (задача 12, 18 августа 2026) ───────────
  // Третья судейская ошибка больше не снимает арбитра на месте: она
  // приостанавливает его и кладёт в цепь обвинение ОТ ИМЕНИ ЦЕПИ — без
  // обвинителя, с поводом, который цепь доказывает сама. Через 48 часов нажать
  // может кто угодно, и права решать нажавший не получает: всё решено до него.
  //
  // ⚠️ ОДИН АРГУМЕНТ — ЭТО НЕ ЭКОНОМИЯ, А ЗАЩИТА. Повод, доказательство, путь
  // и часы кнопка берёт из записи; второго параметра, который можно было бы
  // подкрутить, нет вовсе. И нажать её на ЧЕЛОВЕЧЕСКОМ обвинении нельзя —
  // отказ NotAChainProposal, он же первый по порядку, чтобы посторонний не
  // узнал из ярлыка ошибки, что против арбитра что-то висит.
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'executeChainRemoval',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'hasLiveProposal',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // Пятое поле `live` — не копия формулы TTL, а ответ самого контракта:
    // считать «протухло ли предложение» на фронте значит завести второго
    // хозяина у одного числа.
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getRemovalProposal',
    outputs: [
      { internalType: 'uint8',    name: 'cause',          type: 'uint8' },
      { internalType: 'bytes32',  name: 'evidenceDigest', type: 'bytes32' },
      { internalType: 'uint256',  name: 'proposedAt',     type: 'uint256' },
      { internalType: 'address',  name: 'by',             type: 'address' },
      { internalType: 'bool',     name: 'live',           type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getProposalTTL',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    // Пауза между обвинением и сносом, 48 часов. Спрашивается у цепи, а не
    // считается дома: копия этого числа во фронте разошлась бы молча и
    // показала бы кнопку живой за час до того, как она заработает.
    inputs: [],
    name: 'getRemovalDelay',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    // Потолок слов в БАЙТАХ. Форма обязана показывать остаток по этому числу,
    // а не по своему: разойдясь, они дадут человеку отказ транзакции вместо
    // подсказки в поле.
    inputs: [],
    name: 'getMaxReasonBytes',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'pure',
    type: 'function',
  },
  // ── Право ответа обвинённого ─────────────────────────────────────────────
  //
  // ⚠️ Не «снятого»: с 19 августа 2026 цепь принимает возражение ещё ВО ВРЕМЯ
  // 48-часовой паузы, то есть зовёт эту функцию чаще всего ДЕЙСТВУЮЩИЙ арбитр
  // под живым обвинением.
  //
  // ⚠️ АРГУМЕНТА ДВА, И ВТОРОЙ ДОБАВЛЕН 20 августа 2026 (долг задач 2 и 8).
  // `reply` — ПРАВО, а не обязанность: пустая строка законна и события не
  // порождает. Отпечаток остаётся обязательным — он и есть ответ, а слова его
  // краткое изложение для ленты. Потолок тот же, 512 байт на обе стороны.
  //
  // ⚠️ Прибавка аргумента подняла потолок газа `respondToRemoval` в
  // `lib/relay.ts` с 90 000 до 110 000: замеренное исполнение на полных 512
  // байтах — 72 174 (холодные слоты, строка ПРОКСИ), транзакция целиком
  // ≈ 102 234. Менять одно без другого нельзя — см. docs/OPEN-ITEMS.md, п. 91.
  {
    inputs: [
      { internalType: 'bytes32', name: 'replyDigest', type: 'bytes32' },
      { internalType: 'string',  name: 'reply',       type: 'string' },
    ],
    name: 'respondToRemoval',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getRemovalReply',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── Положение арбитра одним чтением ──────────────────────────────────────
  //
  // ⚠️ Четырнадцать полей ОДНИМ вызовом не ради экономии: собранные семью
  // отдельными запросами, они расходятся сами с собой — между запросами
  // проходят блоки, и залог прочитан до сноса, а статус после.
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getArbiterStanding',
    outputs: [
      { internalType: 'uint256', name: 'xp',                     type: 'uint256' },
      { internalType: 'uint256', name: 'cleanStreak',            type: 'uint256' },
      { internalType: 'uint256', name: 'mistakeStreak',          type: 'uint256' },
      { internalType: 'uint256', name: 'bond',                   type: 'uint256' },
      { internalType: 'address', name: 'seatedBy',               type: 'address' },
      { internalType: 'uint256', name: 'suspendedUntil',         type: 'uint256' },
      { internalType: 'uint256', name: 'openClaims',             type: 'uint256' },
      { internalType: 'uint256', name: 'cleanVerdicts',          type: 'uint256' },
      { internalType: 'uint256', name: 'overturnedVerdicts',     type: 'uint256' },
      { internalType: 'uint256', name: 'removedAt',              type: 'uint256' },
      { internalType: 'bool',    name: 'hasLiveRemovalProposal', type: 'bool' },
      { internalType: 'uint256', name: 'removalCount',           type: 'uint256' },
      { internalType: 'uint256', name: 'lastRemovalAt',          type: 'uint256' },
      { internalType: 'uint8',   name: 'lastRemovalCause',       type: 'uint8' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // ── Отдельные чтения о поведении арбитра ─────────────────────────────────
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'getArbiterMistakeStreak',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'arbiterAddr', type: 'address' }],
    name: 'getCleanVerdicts',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Вторая половина дроби (пункт 101, 21 августа 2026). Читать вместе с
  // getCleanVerdicts выше и никогда порознь: серия ошибок обнуляется чистым
  // вердиктом, поэтому одна лишь она показывала терпеливого плохого арбитра
  // лучше честного новичка. Ни порогов, ни последствий у числа нет.
  {
    inputs: [{ internalType: 'address', name: 'arbiterAddr', type: 'address' }],
    name: 'getOverturnedVerdicts',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'getArbiterBond',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'addr', type: 'address' }],
    name: 'getOpenClaimCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
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
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getArbiterDeals',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── Провенанс посадки ────────────────────────────────────────────────────
  {
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getSeatedBy',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'seater', type: 'address' }],
    name: 'getSeatedCountBy',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── Доказательства: якорь, молчание, отпечатки, ключи ────────────────────
  //
  // ⚠️ Пол записи о молчании здесь СВОИМ ЧИСЛОМ не лежит и лежать не должен:
  // спрашивается у цепи через ArbiterRegistryFacet.getNoResponseFloor()
  // (hooks/useNoResponseFloor.ts). Второе объявление означало бы, что наружу
  // отвечает зеркало, а правило применяется по оригиналу.
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getDisputeClaimedAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getNoResponseAt',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getPresentationDigests',
    outputs: [{ internalType: 'bytes32[]', name: '', type: 'bytes32[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // Два подряд uint256 — перестановка offset/limit по типам НЕВИДИМА, поэтому
    // имена сверяются замком наравне с типами.
    inputs: [
      { internalType: 'address', name: 'agreement', type: 'address' },
      { internalType: 'uint256', name: 'offset',    type: 'uint256' },
      { internalType: 'uint256', name: 'limit',     type: 'uint256' },
    ],
    name: 'getPresentationDigestsPage',
    outputs: [{ internalType: 'bytes32[]', name: '', type: 'bytes32[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'agreement', type: 'address' }],
    name: 'getPresentationDigestCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // Оба возврата bytes32: перепутанные местами имена дают рабочий на вид код,
    // который берёт НЕ ТОТ ключ — читающий код деструктурирует по позиции.
    inputs: [{ internalType: 'address', name: 'arbiter', type: 'address' }],
    name: 'getArbiterChatKeys',
    outputs: [
      { internalType: 'bytes32', name: 'boxKey',  type: 'bytes32' },
      { internalType: 'bytes32', name: 'signKey', type: 'bytes32' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // ── События ──────────────────────────────────────────────────────────────
  //
  // ⚠️ Флаги `indexed` сверяются с исходником наравне с типами: они решают, что
  // уедет в topics, а что в data. Ошибка в них не ревертит ничего — фильтр по
  // арбитру молча не находит НИЧЕГО.
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter', type: 'address' },
      { indexed: true,  internalType: 'address', name: 'by',      type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'until',   type: 'uint256' },
    ],
    name: 'ArbiterSuspended',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'arbiter', type: 'address' },
      { indexed: true, internalType: 'address', name: 'by',      type: 'address' },
    ],
    name: 'ArbiterSuspensionLifted',
    type: 'event',
  },
  {
    // `verifiedByChain` — правда о том, проверила ли цепь повод сама или только
    // заверила отпечаток, не читая, что под ним. Без этой метки обе половины
    // читались бы одинаково, и для второй это было бы враньём.
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter',         type: 'address' },
      { indexed: true,  internalType: 'address', name: 'by',              type: 'address' },
      { indexed: true,  internalType: 'enum ArbiterAccountabilityFacet.Cause', name: 'cause', type: 'uint8' },
      { indexed: false, internalType: 'bool',    name: 'verifiedByChain', type: 'bool' },
      { indexed: false, internalType: 'bytes32', name: 'evidenceDigest',  type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'bondForfeited',   type: 'uint256' },
    ],
    name: 'ArbiterRemovedForCause',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter',        type: 'address' },
      { indexed: true,  internalType: 'address', name: 'by',             type: 'address' },
      { indexed: true,  internalType: 'enum ArbiterAccountabilityFacet.Cause', name: 'cause', type: 'uint8' },
      { indexed: false, internalType: 'bytes32', name: 'evidenceDigest', type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'at',             type: 'uint256' },
    ],
    name: 'RemovalProposed',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'arbiter', type: 'address' },
      { indexed: true, internalType: 'address', name: 'by',      type: 'address' },
    ],
    name: 'RemovalProposalWithdrawn',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter',     type: 'address' },
      { indexed: false, internalType: 'bytes32', name: 'replyDigest', type: 'bytes32' },
    ],
    name: 'RemovalAnswered',
    type: 'event',
  },
  {
    // «Сбылось», в отличие от RemovalProposalWithdrawn («передумали»). Несёт
    // поля СТЁРТОГО предложения, чтобы «предложили за X — снесли за Y» читалось
    // из одной транзакции, без сшивания двух логов по адресу арбитра.
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter',        type: 'address' },
      { indexed: true,  internalType: 'enum ArbiterAccountabilityFacet.Cause', name: 'proposedCause', type: 'uint8' },
      { indexed: true,  internalType: 'address', name: 'proposedBy',     type: 'address' },
      { indexed: false, internalType: 'bytes32', name: 'evidenceDigest', type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'proposedAt',     type: 'uint256' },
    ],
    name: 'RemovalProposalConsumed',
    type: 'event',
  },
  {
    // Слова обвинителя — ОТДЕЛЬНЫМ событием, а не полем в RemovalProposed /
    // ArbiterRemovedForCause: те индексируются живым сабграфом, и смена их
    // подписи остановила бы ленту молча. `stage` различает предложение (0) и
    // снос (1) и уезжает indexed-топиком, чтобы «покажи все обвинения» можно
    // было спросить отдельно от «покажи все сносы».
    //
    // Молчит, если слов нет: пустая строка в ленте стирала бы разницу между
    // «объяснил» и «промолчал».
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter', type: 'address' },
      { indexed: true,  internalType: 'address', name: 'by',      type: 'address' },
      { indexed: true,  internalType: 'uint8',   name: 'stage',   type: 'uint8' },
      { indexed: false, internalType: 'string',  name: 'reason',  type: 'string' },
    ],
    name: 'RemovalReasonGiven',
    type: 'event',
  },
  {
    // Слова обвиняемого. Симметрия с RemovalReasonGiven, но модальность другая:
    // у обвинителя это обязанность, у обвиняемого — право. Поэтому и полей
    // меньше: этапа у ответа нет, отвечают один раз.
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: 'address', name: 'arbiter', type: 'address' },
      { indexed: false, internalType: 'string',  name: 'reply',   type: 'string' },
    ],
    name: 'RemovalReplyGiven',
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
    inputs: [{ internalType: 'address', name: 'who', type: 'address' }],
    name: 'getUnresolvedDisputes',
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
