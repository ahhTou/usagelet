#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from './cli.mjs';
export { collect } from './collect.mjs';
export { aggregate } from './aggregate.mjs';
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
