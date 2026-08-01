
import { adaptV2Input } from './src/engine-v2';
import { deriveV2StateAuthority } from './src/engine-v2/state/derive';

const nowMs = Date.now();
const candles = [];
for (let i = 0; i < 60; i++) {
    candles.push({ ts: nowMs + i * 60000, open: 60000, high: 60020, low: 59980, close: 60000, volume: 1000 });
}
candles[candles.length - 1].close = 60030;

const mockConfig: any = {};
const mockState: any = { directionalShockState: 'UP' };
const input = adaptV2Input('ETHUSDT_TEST', nowMs, {} as any, mockConfig, mockState, {} as any, candles);
const res = deriveV2StateAuthority(input);
console.log('Resulting directionalShockState:', res.directionalShockState);

