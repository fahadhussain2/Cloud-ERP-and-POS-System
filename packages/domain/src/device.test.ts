import deviceCodeCases from '../golden/device-codes.json';
import lockoutCases from '../golden/pin-lockout.json';
import pinRuleCases from '../golden/pin-rules.json';
import {
  nextDeviceCode,
  nextPinState,
  pinProblem,
  type DeviceKind,
  type PinEvent,
  type PinState,
} from './device';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(pinRuleCases as GoldenFile<{ pin: string; shortCode: string | null }>, (i) =>
  pinProblem(i.pin, i.shortCode),
);

runGolden(lockoutCases as GoldenFile<{ state: PinState; events: PinEvent[] }>, (i) => {
  let state = i.state;
  const results: string[] = [];
  for (const event of i.events) {
    const next = nextPinState(state, event);
    state = next.state;
    results.push(next.result);
  }
  return { state, results };
});

runGolden(deviceCodeCases as GoldenFile<{ kind: DeviceKind; existing: string[] }>, (i) =>
  nextDeviceCode(i.kind, i.existing),
);
