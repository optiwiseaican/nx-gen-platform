/**
 * NxGen TLC analysis engine: a TypeScript port of the TLC Tablet app's pure-Kotlin engine,
 * proved against that engine's results on its own fixture plates (engine.spec.ts, __fixtures__).
 * No DOM, no Node APIs: the same code runs in the module API (authoritative, stored results)
 * and in its screens (live preview).
 */
export * from './image';
export * from './linear-algebra';
export * from './plate';
export * from './layout';
export * from './signal';
export * from './quant';
export * from './stats';
export * from './method-layout';
export * from './capture-qc';
