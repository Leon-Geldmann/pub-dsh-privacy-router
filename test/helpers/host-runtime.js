import { loadHostRuntime } from '../../scripts/host-runtime.mjs';
export const hostRuntime = await loadHostRuntime(process.env.DSH_TEST_RUNTIME_CONFIG);
