import businessDateCases from '../golden/business-date.json';
import { businessDate } from './business-date';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(businessDateCases as GoldenFile<{ at: string; timeZone: string; cutoffHour: number }>, (i) =>
  businessDate(Date.parse(i.at), i.timeZone, i.cutoffHour),
);
