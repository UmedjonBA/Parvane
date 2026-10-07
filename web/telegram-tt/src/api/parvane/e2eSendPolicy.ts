export const E2E_SEND_ERROR = 'End-to-end encryption failed. Message was not sent.';

export class E2eSendError extends Error {
  constructor(detail?: string) {
    super(detail ? `${E2E_SEND_ERROR} ${detail}` : E2E_SEND_ERROR);
    this.name = 'E2eSendError';
  }
}

export function getActiveGroupMemberAddresses(
  members: Array<{ address: string; role: string }>,
) {
  return members
    .filter(({ address, role }) => address && role !== 'banned')
    .map(({ address }) => address);
}
