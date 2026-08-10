/**
 * Environment. Lazy getters throughout, so importing this module never throws
 * and a missing variable surfaces as a readable message at the point of use
 * rather than as a container that dies during boot.
 */
import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  get databaseUrl(): string {
    const value = process.env.DATABASE_URL?.trim();
    if (!value) {
      throw new Error(
        'DATABASE_URL is not set. Add a Postgres database to the Railway project and set ' +
          'DATABASE_URL to ${{Postgres.DATABASE_URL}} on this service.',
      );
    }
    return value;
  },

  get firecrawlKey(): string | null {
    return process.env.FIRECRAWL_API_KEY?.trim() || null;
  },

  get port(): number {
    return num('PORT', 3000);
  },

  get transport(): string {
    return optional('TRANSPORT', 'firecrawl');
  },

  /**
   * Where Chrome keeps its profile.
   *
   * Load-bearing rather than a convenience: this directory is where Akamai's
   * cookies accumulate between runs, and a warm session is part of what gets
   * the listings XHR answered instead of tarpitted. On Railway this must be a
   * mounted Volume — otherwise every deploy wipes it and starts cold.
   */
  get profileDir(): string {
    return optional('PROFILE_DIR', path.join(os.tmpdir(), 'bizbuysell-profile'));
  },

  /**
   * Which browser the send path uses when the mode does not name one.
   *
   * Camoufox on a server, because that is what this deployment measured:
   * Chrome from a datacentre IP is refused by Akamai and Camoufox is not.
   */
  get defaultWriteBrowser(): string {
    return optional('DEFAULT_WRITE_BROWSER', 'camoufox');
  },

  get nodeEnv(): string {
    return optional('NODE_ENV', 'development');
  },
};

/** Non-throwing report, for the health endpoint and the boot banner. */
export function envProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.DATABASE_URL?.trim()) problems.push('DATABASE_URL is not set');
  if (!process.env.FIRECRAWL_API_KEY?.trim()) {
    problems.push('FIRECRAWL_API_KEY is not set — the firecrawl transport will not work');
  }
  return problems;
}
