#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

// Node won't strip types under node_modules, so an installed package runs the compiled dist/.
// A checkout (cloned, or linked with `pnpm add -g link:…`) always runs the sources, so a stale
// dist/ there can never shadow the code being edited.
const installed = fileURLToPath(import.meta.url)
  .split(/[\\/]/)
  .includes('node_modules');
const { main } = installed ? await import('../dist/cli.js') : await import('../src/cli.ts');

process.exitCode = await main(process.argv.slice(2));
