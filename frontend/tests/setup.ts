import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => { vi.stubEnv('DEV', false); });
afterEach(() => { vi.unstubAllEnvs(); });
