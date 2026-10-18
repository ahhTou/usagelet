#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { main } from './cli.mjs';
export { collect } from './collect.mjs';
export { aggregateRows, reportJson, renderTable } from './report.mjs';
export { PricingMap } from './pricing.mjs';
export { VERSION } from './shared.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`usagelet: ${e.message}`);
      process.exitCode = 1;
    },
  );
