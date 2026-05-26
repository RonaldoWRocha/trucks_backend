import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

export function loadEnvironment() {
  const files = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', 'telemetria_dados', '.env'),
  ];

  for (const path of files) {
    if (existsSync(path)) {
      config({ path, override: false });
    }
  }
}
