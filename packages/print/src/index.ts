// Printing building blocks shared by the counter, the cash desk and the back office (architecture §8).
export { billHeaderLines, type BillHeaderSource } from './bill-header';
export {
  CODE39_CHARACTERS,
  Code39Error,
  code39Svg,
  code39Width,
  encodeCode39,
  type Code39Options,
  type Code39Problem,
} from './code39';
