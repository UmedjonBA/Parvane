// Parvane: API-слой подменён — вместо MTProto (worker/connector) все методы и
// апдейты обслуживает провайдер шины Parvane (NATS/JSON через gateway).
export {
  initApi, callApi, cancelApiProgress, cancelApiProgressMaster, callApiLocal,
  handleMethodCallback,
  handleMethodResponse,
  updateFullLocalDb,
  updateLocalDb,
  setShouldEnableDebugLog,
} from '../parvane/provider';
