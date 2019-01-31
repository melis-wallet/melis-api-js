var C = {}
C.CLIENT_API_VERSION = "0.9.3"

// Websocket official urls
C.MELIS_DISCOVER = "https://discover.melis.io/api/v1/endpoint/stomp"
C.MELIS_TEST_DISCOVER = "https://discover-test.melis.io/api/v1/endpoint/stomp"

// Standard queues used for communication
C.QUEUE_RPC_REPLY = "/user/queue/rpc"
C.QUEUE_RPC_ERROR = "/user/queue/errors"
C.QUEUE_SERVER_EVENTS = "/user/queue/messages"
C.QUEUE_TICKERS_PREFIX = "/topic/tickers/"
C.QUEUE_TICKERS_HISTORY_PREFIX = "/topic/tickersHistory/"
C.QUEUE_BLOCKS = "/topic/blocks"
C.QUEUE_PUBLIC_MSGS = "/topic/messages"

C.EX_TOO_MANY_REQUESTS = "CmTooManyRequestException"

// application prefixes
C.PREFIX_APP = "/app/"
C.QUEUE_CONFIG = C.PREFIX_APP + "v1/config"

// Public methods (no auth required)
C.PREFIX_PUBLIC_METHODS = C.PREFIX_APP + "v1/public/"
C.GET_PAYMENT_ADDRESS = C.PREFIX_PUBLIC_METHODS + "getPaymentAddress"
C.GET_ACCOUNT_PUBLIC_INFO = C.PREFIX_PUBLIC_METHODS + "getAccountPublicInfo"

// Wallet methods
C.PREFIX_WALLET_METHODS = C.PREFIX_APP + "v1/wallet/"
C.GET_CHALLENGE = C.PREFIX_WALLET_METHODS + "getChallenge"
C.WALLET_OPEN = C.PREFIX_WALLET_METHODS + "open"
C.WALLET_CLOSE = C.PREFIX_WALLET_METHODS + "close"
C.WALLET_REGISTER = C.PREFIX_WALLET_METHODS + "register"
C.WALLET_GET_FREE_ACCOUNT_NUM = C.PREFIX_WALLET_METHODS + "getFreeAccountNumber"
C.WALLET_ADD_LEGACY_ADDRESS = C.PREFIX_WALLET_METHODS + "legacyAddressAdd"
//C.WALLET_GET_CUSTOM_KEY = C.PREFIX_WALLET_METHODS + "getCustomPubKey"
//C.WALLET_GET_CUSTOM_KEYS = C.PREFIX_WALLET_METHODS + "getCustomPubKeys"
C.WALLET_META_SET = C.PREFIX_WALLET_METHODS + "metaSet"
C.WALLET_META_GET = C.PREFIX_WALLET_METHODS + "metaGet"
C.WALLET_META_DELETE = C.PREFIX_WALLET_METHODS + "metaDelete"
C.WALLET_METAS_GET = C.PREFIX_WALLET_METHODS + "metasGet"
C.WALLET_GET_INFO = C.PREFIX_WALLET_METHODS + "info"
C.WALLET_GET_NOTIFICATIONS = C.PREFIX_WALLET_METHODS + "getNotifications"
C.WALLET_GET_NUM_SESSIONS = C.PREFIX_WALLET_METHODS + "getNumSessions"
C.WALLET_DEVICE_SET_PASSWORD = C.PREFIX_WALLET_METHODS + "deviceSetPassword"
C.WALLET_DEVICE_GET_PASSWORD = C.PREFIX_WALLET_METHODS + "deviceGetPassword"
C.WALLET_DEVICE_UPDATE = C.PREFIX_WALLET_METHODS + "deviceUpdate"
C.WALLET_DEVICE_CHANGE_PIN = C.PREFIX_WALLET_METHODS + "deviceChangePin"
C.WALLET_DEVICE_PROMOTE_TO_PRIMARY = C.PREFIX_WALLET_METHODS + "devicePromoteToPrimary"
C.WALLET_DEVICE_CANCEL_PROMOTION = C.PREFIX_WALLET_METHODS + "deviceCancelPromotion"
C.WALLET_DEVICE_GET_RECOVERY_HOURS = C.PREFIX_WALLET_METHODS + "deviceGetRecoveryHours"
C.WALLET_DEVICE_SET_RECOVERY_HOURS = C.PREFIX_WALLET_METHODS + "deviceSetRecoveryHours"
C.WALLET_DEVICES_GET = C.PREFIX_WALLET_METHODS + "devicesGet"
C.WALLET_DEVICES_DELETE = C.PREFIX_WALLET_METHODS + "devicesDelete"
C.WALLET_DEVICES_DELETE_ALL = C.PREFIX_WALLET_METHODS + "devicesDeleteAll"
C.WALLET_PUSH_REGISTER_GOOGLE = C.PREFIX_WALLET_METHODS + "addPushToken/google"

// Wallet types
C.TYPE_LEGACY = 'L'
C.TYPE_PLAIN_HD = 'H'
C.TYPE_2OF2_SERVER = '2'
C.TYPE_MULTISIG_MANDATORY_SERVER = 'M'
C.TYPE_MULTISIG_NON_MANDATORY_SERVER = 'O'
C.TYPE_MULTISIG_NO_SERVER = 'N'
C.TYPE_COSIGNER = 'C'

// Account methods
C.PREFIX_ACCOUNT_METHODS = C.PREFIX_APP + "v1/account/"
C.ACCOUNT_OPEN = C.PREFIX_ACCOUNT_METHODS + "open"
C.ACCOUNT_REFRESH = C.PREFIX_ACCOUNT_METHODS + "refresh"
C.ACCOUNT_JOIN = C.PREFIX_ACCOUNT_METHODS + "join"
C.ACCOUNT_REGISTER = C.PREFIX_ACCOUNT_METHODS + "register"
C.ACCOUNT_UPDATE = C.PREFIX_ACCOUNT_METHODS + "update"
C.ACCOUNT_DELETE = C.PREFIX_ACCOUNT_METHODS + "delete"
C.ACCOUNT_GET_UNUSED_ADDRESS = C.PREFIX_ACCOUNT_METHODS + "getUnusedAddress"
C.ACCOUNT_ADDRESS_UPDATE = C.PREFIX_ACCOUNT_METHODS + "addressUpdate"
C.ACCOUNT_ADDRESS_RELEASE = C.PREFIX_ACCOUNT_METHODS + "addressRelease"
C.ACCOUNT_ADDRESS_GET = C.PREFIX_ACCOUNT_METHODS + "addressGet"
C.ACCOUNT_ADDRESSES_GET = C.PREFIX_ACCOUNT_METHODS + "addressesGet"
C.ACCOUNT_GET_UNSPENTS = C.PREFIX_ACCOUNT_METHODS + "getUnspents"
C.ACCOUNT_GET_EXPIRING_UNSPENTS = C.PREFIX_ACCOUNT_METHODS + "getExpiringUnspents"
C.ACCOUNT_GET_INFO = C.PREFIX_ACCOUNT_METHODS + "getInfo"
C.ACCOUNT_GET_JOIN_CODE_INFO = C.PREFIX_ACCOUNT_METHODS + "getJoinCodeInfo"
C.ACCOUNT_GET_NOTIFICATIONS = C.PREFIX_ACCOUNT_METHODS + "getNotifications"
C.ACCOUNT_PTX_PREPARE = C.PREFIX_ACCOUNT_METHODS + "ptxPrepare"
C.ACCOUNT_PTX_GET = C.PREFIX_ACCOUNT_METHODS + "ptxGet"
C.ACCOUNT_PTXS_GET = C.PREFIX_ACCOUNT_METHODS + "ptxsGet"
C.ACCOUNT_PTX_CANCEL = C.PREFIX_ACCOUNT_METHODS + "ptxCancel"
C.ACCOUNT_PTX_SIGN_FIELDS = C.PREFIX_ACCOUNT_METHODS + "ptxSignFields"
C.ACCOUNT_PTX_FEE_BUMP = C.PREFIX_ACCOUNT_METHODS + "ptxFeeBump"
C.ACCOUNT_SUBMIT_SIGNATURES = C.PREFIX_ACCOUNT_METHODS + "signaturesSubmit"
C.ACCOUNT_GET_TX_INFOS = C.PREFIX_ACCOUNT_METHODS + "txInfosGet"
C.ACCOUNT_GET_TX_INFO = C.PREFIX_ACCOUNT_METHODS + "txInfoGet"
C.ACCOUNT_SET_TX_INFO = C.PREFIX_ACCOUNT_METHODS + "txInfoSet"
C.ACCOUNT_GET_ALL_LABELS = C.PREFIX_ACCOUNT_METHODS + "getAllLabels"
C.ACCOUNT_LIMITS_GET = C.PREFIX_ACCOUNT_METHODS + "limitsGet"
C.ACCOUNT_LIMIT_SET = C.PREFIX_ACCOUNT_METHODS + "limitSet"
C.ACCOUNT_LIMIT_CANCEL_CHANGE = C.PREFIX_ACCOUNT_METHODS + "limitCancelChange"
C.ACCOUNT_ALIAS_INFO = C.PREFIX_ACCOUNT_METHODS + "aliasInfo"
C.ACCOUNT_ALIAS_AVAILABLE = C.PREFIX_ACCOUNT_METHODS + "aliasAvailable"
C.ACCOUNT_ALIAS_DEFINE = C.PREFIX_ACCOUNT_METHODS + "aliasDefine"
C.ACCOUNT_GET_LOCKTIME_DAYS = C.PREFIX_ACCOUNT_METHODS + "getLockTimeDays"
C.ACCOUNT_SET_LOCKTIME_DAYS = C.PREFIX_ACCOUNT_METHODS + "setLockTimeDays"
C.ACCOUNT_GET_RECOVERY_INFO = C.PREFIX_ACCOUNT_METHODS + "getRecoveryInfo"

// Account status
C.STATUS_ALL_COSIGNERS_OK = 'A'
C.STATUS_WAITING_COSIGNERS = 'W'
C.STATUS_DELETED = 'D'

// Message methods to chat with other users
C.PREFIX_MSG_METHODS = C.PREFIX_APP + "v1/msg/"
C.MSG_SEND_TO_ACCOUNT = C.PREFIX_MSG_METHODS + "sendToAccount"
C.MSG_SEND_TO_PTX = C.PREFIX_MSG_METHODS + "sendToPtx"
C.MSG_GET_ALL_TO_WALLET = C.PREFIX_MSG_METHODS + "getToWallet"
C.MSG_GET_ALL_TO_PTX = C.PREFIX_MSG_METHODS + "getToPtx"
C.MSG_GET_ALL_TO_PTXS = C.PREFIX_MSG_METHODS + "getToPtxs"

// TFA methods
C.PREFIX_TFA_METHODS = C.PREFIX_APP + "v1/tfa/"
C.TFA_AUTH_REQUEST = C.PREFIX_TFA_METHODS + "authRequest"
C.TFA_AUTH_VALIDATE = C.PREFIX_TFA_METHODS + "authValidate"
C.TFA_ENROLL_START = C.PREFIX_TFA_METHODS + "enrollStart"
C.TFA_ENROLL_FINISH = C.PREFIX_TFA_METHODS + "enrollFinish"
C.TFA_DEVICE_SET_META = C.PREFIX_TFA_METHODS + "deviceSetMeta"
C.TFA_DEVICE_SET_NOTIFICATIONS = C.PREFIX_TFA_METHODS + "deviceSetNotifications"
C.TFA_DEVICE_DELETE = C.PREFIX_TFA_METHODS + "deviceDelete"
C.TFA_PROPOSE_DELETE_DEVICES = C.PREFIX_TFA_METHODS + "proposeDeleteDevices"
C.TFA_GET_WALLET_CONFIG = C.PREFIX_TFA_METHODS + "wallet/getConfig"
C.TFA_GET_ACCOUNT_CONFIG = C.PREFIX_TFA_METHODS + "account/getConfig"
C.TFA_SET_ACCOUNT_CONFIG = C.PREFIX_TFA_METHODS + "account/setConfig"

// Session methods
C.PREFIX_SESSION_METHODS = C.PREFIX_APP + "v1/session/"
C.SESSION_SET_PARAMS = C.PREFIX_SESSION_METHODS + "setParams"

// TFA Constants
C.TFA_POLICY_DEFAULT = "default"
C.TFA_POLICY_ANY = "any"
C.TFA_POLICY_NONE = "none"
C.TFA_DEVICE_RFC6238 = "rfc6238"
C.TFA_DEVICE_EMAIL = "email"
C.TFA_DEVICE_SMS = "sms"

// Addressbook methods
C.PREFIX_AB_METHODS = C.PREFIX_APP + "v1/ab/"
C.AB_ADD = C.PREFIX_AB_METHODS + "add"
C.AB_GET = C.PREFIX_AB_METHODS + "get"
C.AB_DELETE = C.PREFIX_AB_METHODS + "delete"
C.AB_UPDATE = C.PREFIX_AB_METHODS + "update"

// Addressbook entry types
C.AB_TYPE_MELIS = 'melis'
C.AB_TYPE_ADDRESS = 'addr'

// Utilities methods
C.PREFIX_UTILS_METHODS = C.PREFIX_APP + "v1/utils/"
C.UTILS_PUSH_TX = C.PREFIX_UTILS_METHODS + "pushTx"
C.UTILS_FEE_INFO = C.PREFIX_UTILS_METHODS + "feeInfo"
C.UTILS_LOG_EX = C.PREFIX_UTILS_METHODS + "logException"
C.UTILS_LOG_DATA = C.PREFIX_UTILS_METHODS + "logData"
C.UTILS_PING = C.PREFIX_UTILS_METHODS + "ping"
C.UTILS_PONG = C.PREFIX_UTILS_METHODS + "pong"

// Fork Claiming methods
C.PREFIX_CLAIMER_METHODS = C.PREFIX_APP + "v1/forkClaimer/"
C.PREPARE_UNSPENT_FORK_CLAIM = C.PREFIX_CLAIMER_METHODS + "prepareUnspentForkClaim"
C.SUBMIT_FORK_CLAIM = C.PREFIX_CLAIMER_METHODS + "submitClaim"

// Events
C.UNHANDLED_EVENT = 'unhandled'
C.EVENT_CONNECT = 'connect'
C.EVENT_DISCONNECT = 'disconnect'
C.EVENT_SESSION_RESTORED = 'sessionRestored'
C.EVENT_BLOCK = 'block'
C.EVENT_NEW_SESSION = 'newSession'
C.EVENT_CLOSE_SESSION = 'closeSession'
C.EVENT_WALLET_OPENED = 'walletOpened'
C.EVENT_RPC_ACTIVITY_START = 'rpcActivityStart'
C.EVENT_RPC_ACTIVITY_END = 'rpcActivityEnd'
C.EVENT_CONFIG = 'config'
C.EVENT_JOINED = "joined"
C.EVENT_JOIN_REQUEST = "joinRequest"
C.EVENT_TX_INFO_NEW = "txInfoNew"
C.EVENT_TX_INFO_UPDATED = "txInfoUpdated"
C.EVENT_PTX_NEW = "newPtx"
C.EVENT_PTX_UPDATED = "ptxUpdated"
C.EVENT_ACCOUNT = "accountMsg"
C.EVENT_NEW_ACCOUNT = "newAccount"
C.EVENT_ACCOUNT_UPDATED = "accountUpdated"
C.EVENT_ACCOUNT_DELETED = "accountDeleted"
C.EVENT_ADDRESS_UPDATED = "addrUpdated"
C.EVENT_NEW_PRIMARY_DEVICE = "newPrimaryDevice"
C.EVENT_DEVICE_LOGIN = "newDeviceLogin"
C.EVENT_DEVICE_DELETED = "deviceDeleted"
C.EVENT_PUBLIC_MESSAGE = "publicMsg"
C.EVENT_LIMITS = "limits"
C.EVENT_TFA_DISABLE_PROPOSAL = "tfaDisableProposal"
C.EVENT_MESSAGE = "msg"
C.EVENT_PING = "ping"
C.EVENT_SYSTEM_STATUS = "systemStatus"
C.EVENT_DISCONNECT_REQ = "disconnectReq"

// ptx statuses
C.PTX_STATUS_ACTIVE = "ACTIVE"
C.PTX_STATUS_RESPENT = "RESPENT"
C.PTX_STATUS_BROADCASTED = "BROADCASTED"
C.PTX_STATUS_CANCELED = "CANCELED"

// Spending limits types
C.LIMIT_DAILY = "daily"
C.LIMIT_WEEKLY = "weekly"
C.LIMIT_MONTHLY = "monthly"
C.LIMIT_NONE = -1
C.LIMIT_REQ_CHANGE = "limitChangeRequest"
C.LIMIT_REQ_CANCEL = "limitChangeCancel"

// Chat message types
C.CHAT_MSG_TYPE_MSG = "M"
C.CHAT_MSG_TYPE_SIG = "S"

// Supported production coins
C.COIN_PROD_BTC = "BTC"
C.COIN_PROD_BCH = "BCH"
C.COIN_PROD_LTC = "LTC"
C.COIN_PROD_GRS = "GRS"
C.COIN_PROD_BSV = "BSV"
C.COIN_PROD_DOGE = "DOGE"

// Supported testnet coins
C.COIN_TEST_BTC = "TBTC"
C.COIN_TEST_BCH = "TBCH"
C.COIN_TEST_LTC = "TLTC"
C.COIN_TEST_GRS = "TGRS"
C.COIN_TEST_BSV = "TBSV"
C.COIN_TEST_DOGE = "TDOG"

// Supported regtest coins
C.COIN_REGTEST_BTC = "RBTC"
C.COIN_REGTEST_BCH = "RBCH"
C.COIN_REGTEST_LTC = "RLTC"
C.COIN_REGTEST_GRS = "RGRS"
C.COIN_REGTEST_BSV = "RBSV"
C.COIN_REGTEST_DOGE = "RDOG"

C.MAX_SUBPATH = 16777216
C.SATOSHIS_ONE_BIT = 100
C.SATOSHIS_ONE_MBTC = 100000
C.SATOSHIS_ONE_BTC = 100000000

C.CURRENCY_EUR = "EUR"
C.CURRENCY_USD = "USD"
C.CURRENCY_GBP = "GBP"
C.CURRENCY_CNY = "CNY"

C.HISTORY_SLIDING_24H = "sliding-24h"
C.HISTORY_SLIDING_30D = "sliding-30d"
C.HISTORY_SLIDING_365D = "sliding-365d"

C.HISTORY_SLIDING_DAILY = "daily"
C.HISTORY_SLIDING_MONTHLY = "monthly"
C.HISTORY_SLIDING_YEARLY = "yearly"

C.DIR_ASCENDING = "ASC"
C.DIR_DESCENDING = "DESC"

C.FIELD_ADDRESS = "address"
C.FIELD_AMOUNT = "amount"
C.FIELD_CREATION_DATE = "creationDate"
C.FIELD_BLOCK_EXPIRE = "blockExpire"
C.FIELD_LAST_UPDATED = "lastUpdated"
C.FIELD_LAST_REQUESTED = "lastRequested"

C.MSG_PREFIX_LEGACY_ADDR = "Legacy Address: "
C.MSG_PREFIX_INSTANT_VERIFY = "Verify Melis instantTx: "

C.MELIS_USER_AGENT = "/melis-api/"

C.VALID_BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
C.VALID_PUB_ID_REGEX = new RegExp("^((CM)|(M[01ZzYyXxWw]))[" + C.VALID_BASE58_CHARS + "]{26,28}$")
C.VALID_ALIAS_REGEX = new RegExp(/^[a-z0-9][a-z0-9-\\.]{2,61}$/)
C.LEGACY_BITCOIN_REGEX = new RegExp(/^[132mn][a-km-zA-HJ-NP-Z0-9]{25,34}$/)
C.BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

module.exports = C