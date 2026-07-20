export const E2E_SEND_ERROR = 'End-to-end encryption failed. Message was not sent.';

export class E2eSendError extends Error {
  constructor(detail?: string) {
    super(detail ? `${E2E_SEND_ERROR} ${detail}` : E2E_SEND_ERROR);
    this.name = 'E2eSendError';
  }
}

export function requireE2e<T>(engine: T | undefined): T {
  if (!engine) throw new E2eSendError('Encryption engine is unavailable.');
  return engine;
}

export function requireEncrypted<T>(value: T | undefined, detail: string): T {
  if (value === undefined) throw new E2eSendError(detail);
  return value;
}

export function getActiveGroupMemberAddresses(
  members: Array<{ address: string; role: string }>,
) {
  return members
    .filter(({ address, role }) => address && role !== 'banned')
    .map(({ address }) => address);
}

export async function deliverToEveryGroupMember(
  members: string[],
  self: string,
  deliver: (member: string) => Promise<boolean>,
) {
  const recipients = Array.from(new Set(members)).filter((member) => member && member !== self);
  for (const member of recipients) {
    let delivered = false;
    try {
      delivered = await deliver(member);
    } catch {
      // Convert crypto/network details into one predictable fail-closed result.
    }
    if (!delivered) throw new E2eSendError(`Group key was not delivered to ${member}.`);
  }
}
