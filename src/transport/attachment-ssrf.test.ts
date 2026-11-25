import { describe, expect, it } from 'vitest';
import {
  assertSafeHostname,
  isPrivateAddress,
  resolveHostAddresses,
  type HostResolver,
} from './attachment.ts';

const resolver = (overrides: Partial<HostResolver>): HostResolver => ({
  lookup: async () => [],
  resolve4: async () => [],
  resolve6: async () => [],
  ...overrides,
});

describe('isPrivateAddress', () => {
  it('flags private, loopback, CGNAT and multicast IPv4', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.1.1', '224.0.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('keeps public IPv4 public', () => {
    for (const ip of ['183.60.230.228', '14.17.85.88', '8.8.8.8', '172.32.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('flags loopback, link-local, unique-local and multicast IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fe80::7f02:c958:d556:3e74%2', 'fd12:3456::1', 'fc00::1', 'ff02::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('keeps public IPv6 public, including the QQ media range', () => {
    for (const ip of ['240e:97c:2f:3003::47', '240e:3bc:ce7:3570:b042:2fa:bb2e:4ac6', '2001:4860:4860::8888']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('judges IPv4-mapped IPv6 by the embedded IPv4', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('treats unparsable values as public rather than silently blocking', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(false);
    expect(isPrivateAddress('999.1.1.1')).toBe(false);
  });
});

describe('resolveHostAddresses', () => {
  it('uses the system resolver first (the path curl/PowerShell take)', async () => {
    const addresses = await resolveHostAddresses('multimedia.nt.qq.com.cn', resolver({
      lookup: async () => ['183.60.230.228', '240e:97c:2f:3003::47'],
      resolve4: async () => { throw new Error('c-ares could not reach fe80::1'); },
    }));
    expect(addresses).toEqual(['183.60.230.228', '240e:97c:2f:3003::47']);
  });

  it('falls back to c-ares A/AAAA when the system resolver returns nothing', async () => {
    const addresses = await resolveHostAddresses('example.com', resolver({
      lookup: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => ['2606:2800:220:1::1'],
    }));
    expect(addresses).toEqual(['93.184.216.34', '2606:2800:220:1::1']);
  });

  it('returns an empty list only when every resolver fails', async () => {
    const addresses = await resolveHostAddresses('nope.invalid', resolver({
      lookup: async () => { throw new Error('ENOTFOUND'); },
      resolve4: async () => { throw new Error('ETIMEOUT'); },
      resolve6: async () => { throw new Error('ETIMEOUT'); },
    }));
    expect(addresses).toEqual([]);
  });
});

describe('assertSafeHostname', () => {
  it('passes when only the system resolver can answer', async () => {
    await expect(assertSafeHostname('multimedia.nt.qq.com.cn', resolver({
      lookup: async () => ['183.60.230.228'],
      resolve4: async () => [],
    }))).resolves.toBeUndefined();
  });

  it('blocks a host that resolves to a private IPv4', async () => {
    await expect(assertSafeHostname('evil.test', resolver({
      lookup: async () => ['192.168.1.10'],
    }))).rejects.toThrow(/SSRF blocked/);
  });

  it('blocks a host that resolves to a link-local IPv6', async () => {
    await expect(assertSafeHostname('evil6.test', resolver({
      lookup: async () => ['fe80::1'],
    }))).rejects.toThrow(/SSRF blocked/);
  });

  it('still reports a DNS failure when nothing resolves', async () => {
    await expect(assertSafeHostname('dead.test', resolver({}))).rejects.toThrow(/DNS resolution failed/);
  });
});
