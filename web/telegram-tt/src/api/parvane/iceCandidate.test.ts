import { describe, expect, it } from 'vitest';

import { decodeIceCandidate, encodeIceCandidate } from './iceCandidate';

// CALL-1: один формат ICE-кандидата во всех клиентах, приём прежних видов.

const SDP = 'candidate:1 1 udp 2122260223 127.0.0.1 5000 typ host';

describe('CALL-1: ICE-кандидат звонка', () => {
  it('кодирует канонические поля и прежние имена web и desktop', () => {
    const encoded = JSON.parse(encodeIceCandidate({ candidate: SDP, sdpMid: '0', sdpMLineIndex: 0 }));
    expect(encoded).toMatchObject({
      candidate: SDP,
      sdp_mid: '0',
      sdp_mline_index: 0,
      sdpMid: '0',
      sdpMLineIndex: 0,
      sdp: SDP,
      mid: '0',
      idx: 0,
    });
  });

  it('разбирает канонический вид, вид web и прежний вид desktop', () => {
    expect(decodeIceCandidate(JSON.stringify({ candidate: SDP, sdp_mid: '1', sdp_mline_index: 2 })))
      .toMatchObject({ candidate: SDP, sdpMid: '1', sdpMLineIndex: 2 });
    expect(decodeIceCandidate(JSON.stringify({
      candidate: SDP, sdpMid: 'audio', sdpMLineIndex: 1, usernameFragment: 'ab',
    }))).toEqual({
      candidate: SDP, sdpMid: 'audio', sdpMLineIndex: 1, usernameFragment: 'ab',
    });
    expect(decodeIceCandidate(JSON.stringify({ sdp: SDP, mid: '0', idx: 0 })))
      .toMatchObject({ candidate: SDP, sdpMid: '0', sdpMLineIndex: 0 });
  });

  it('свой же вывод читается обратно', () => {
    const init = { candidate: SDP, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'uf' };
    expect(decodeIceCandidate(encodeIceCandidate(init))).toEqual(init);
  });

  it('не JSON и объект без кандидата отвергаются', () => {
    expect(decodeIceCandidate('cand-plain')).toBeUndefined();
    expect(decodeIceCandidate(JSON.stringify({ sdpMid: '0' }))).toBeUndefined();
    expect(decodeIceCandidate('null')).toBeUndefined();
  });
});
