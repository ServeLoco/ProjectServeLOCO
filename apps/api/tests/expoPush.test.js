// Tests for the Expo push helper at src/utils/expoPush.js.
// Focus: pruning users.push_token when an Expo ticket reports DeviceNotRegistered.

// Programmable mock so each test can choose what `sendPushNotificationsAsync`
// resolves with (the static fixture in tests/__mocks__/expo-server-sdk.js always
// returns [] and would hide the cleanup branch).
let mockSendPushNotificationsAsync = jest.fn(async () => []);
let mockChunkPushNotifications = (messages) => [messages];

jest.mock('expo-server-sdk', () => ({
  Expo: class {
    static isExpoPushToken(token) {
      return typeof token === 'string' && token.startsWith('ExponentPushToken[');
    }
    chunkPushNotifications(messages) {
      return mockChunkPushNotifications(messages);
    }
    async sendPushNotificationsAsync(messages) {
      return mockSendPushNotificationsAsync(messages);
    }
  }
}));

const { pool } = require('../src/db/mysql');
jest.mock('../src/db/mysql', () => ({ pool: { query: jest.fn() } }));

const { sendPushToUser, sendPushToMany, cleanupDeadTokens, countPushEligible } = require('../src/utils/expoPush');

const VALID_TOKEN_A = 'ExponentPushToken[AAAA]';
const VALID_TOKEN_B = 'ExponentPushToken[BBBB]';
const VALID_TOKEN_C = 'ExponentPushToken[CCCC]';

beforeEach(() => {
  jest.clearAllMocks();
  mockSendPushNotificationsAsync = jest.fn(async () => []);
  mockChunkPushNotifications = (messages) => [messages];
});

describe('expoPush.cleanupDeadTokens', () => {
  it('nulls push_token for tickets with status=error and details.error=DeviceNotRegistered', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const tickets = [
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ];
    await cleanupDeadTokens(pool, tickets, [VALID_TOKEN_A]);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE users SET push_token = NULL WHERE push_token = ?',
      [VALID_TOKEN_A]
    );
  });

  it('ignores tickets with a non-DeviceNotRegistered error', async () => {
    pool.query.mockResolvedValue([{ affectedRows: 0 }]);

    const tickets = [
      { status: 'error', details: { error: 'InvalidCredentials' } },
      { status: 'error', details: { error: 'MessageTooBig' } },
    ];
    await cleanupDeadTokens(pool, tickets, [VALID_TOKEN_A, VALID_TOKEN_B]);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('ignores tickets with status=ok', async () => {
    pool.query.mockResolvedValue([{ affectedRows: 0 }]);

    const tickets = [
      { status: 'ok', id: 'ticket-1' },
    ];
    await cleanupDeadTokens(pool, tickets, [VALID_TOKEN_A]);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('pairs each dead ticket with the token at the same index', async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const tickets = [
      { status: 'ok' },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok' },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ];
    await cleanupDeadTokens(pool, tickets, [VALID_TOKEN_A, VALID_TOKEN_B, VALID_TOKEN_C, VALID_TOKEN_A]);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      'UPDATE users SET push_token = NULL WHERE push_token = ?',
      [VALID_TOKEN_B]
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      'UPDATE users SET push_token = NULL WHERE push_token = ?',
      [VALID_TOKEN_A]
    );
  });

  it('skips null/empty token entries and does not query the DB for them', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const tickets = [
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ];
    await cleanupDeadTokens(pool, tickets, [VALID_TOKEN_A, '']);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE users SET push_token = NULL WHERE push_token = ?',
      [VALID_TOKEN_A]
    );
  });

  it('swallows DB errors and never throws', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection lost'));

    const tickets = [
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ];
    await expect(cleanupDeadTokens(pool, tickets, [VALID_TOKEN_A])).resolves.toBeUndefined();
  });

  it('does nothing when the tickets array is empty', async () => {
    await cleanupDeadTokens(pool, [], []);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('expoPush.sendPushToUser', () => {
  it('nulls push_token when the ticket reports DeviceNotRegistered', async () => {
    // 1) SELECT push_token, 2) UPDATE push_token = NULL
    pool.query
      .mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    mockSendPushNotificationsAsync = jest.fn(async () => [
      { status: 'error', details: { error: 'DeviceNotRegistered' } }
    ]);

    await sendPushToUser(pool, 42, { title: 'Hi', body: 'There' });

    expect(mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const calls = pool.query.mock.calls;
    const updateCall = calls.find(([sql]) => /UPDATE users SET push_token = NULL WHERE push_token = \?/i.test(sql));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual([VALID_TOKEN_A]);
  });

  it('does not query UPDATE when the ticket is ok', async () => {
    pool.query.mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]]);
    mockSendPushNotificationsAsync = jest.fn(async () => [{ status: 'ok', id: 'abc' }]);

    await sendPushToUser(pool, 42, { title: 'Hi', body: 'There' });

    const calls = pool.query.mock.calls;
    const updateCall = calls.find(([sql]) => /UPDATE users SET push_token = NULL/i.test(sql));
    expect(updateCall).toBeUndefined();
  });

  it('returns early without sending or updating when the user has no push_token', async () => {
    pool.query.mockResolvedValueOnce([[]]); // empty rows

    await sendPushToUser(pool, 42, { title: 'Hi', body: 'There' });

    expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
    const calls = pool.query.mock.calls;
    const updateCall = calls.find(([sql]) => /UPDATE users SET push_token = NULL/i.test(sql));
    expect(updateCall).toBeUndefined();
  });

  it('returns early without sending or updating when the token is not an Expo push token', async () => {
    pool.query.mockResolvedValueOnce([[{ push_token: 'not-an-expo-token' }]]);

    await sendPushToUser(pool, 42, { title: 'Hi', body: 'There' });

    expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
    const calls = pool.query.mock.calls;
    const updateCall = calls.find(([sql]) => /UPDATE users SET push_token = NULL/i.test(sql));
    expect(updateCall).toBeUndefined();
  });

  it('swallows send errors so they never propagate to the caller', async () => {
    pool.query.mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]]);
    mockSendPushNotificationsAsync = jest.fn(async () => { throw new Error('expo down'); });

    await expect(
      sendPushToUser(pool, 42, { title: 'Hi', body: 'There' })
    ).resolves.toEqual({ sent: false, reason: 'expo down' });
  });

  it('includes title, body, and sound; accepts custom sound/tag/collapseId', async () => {
    pool.query.mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]]);
    mockSendPushNotificationsAsync = jest.fn(async () => [{ status: 'ok', id: 't1' }]);

    await sendPushToUser(pool, 42, {
      title: 'Delivery offer waiting',
      body: 'Order 1042 — accept now before it expires',
      channelId: 'serveloco-rider-offers-alarm-v5',
      sound: 'rider_alarm',
      tag: 'rider_offer_9',
      collapseId: 'rider_offer_9',
      data: { alertType: 'rider_offer_alarm', offerId: 9 },
    });

    const [messages] = mockSendPushNotificationsAsync.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      to: VALID_TOKEN_A,
      // Call sites pass the Android res/raw basename; the payload's `sound`
      // is consulted only by APNs, which needs the bundled filename.
      sound: 'rider_alarm.wav',
      title: 'Delivery offer waiting',
      body: 'Order 1042 — accept now before it expires',
      data: { alertType: 'rider_offer_alarm', offerId: '9' },
      channelId: 'serveloco-rider-offers-alarm-v5',
      priority: 'high',
      ttl: 3600,
      tag: 'rider_offer_9',
      collapseId: 'rider_offer_9',
    });
  });

  // On Android 8+ the sound comes from the notification channel (registered
  // client-side as ORDER_ALARM_CHANNEL_ID with sound: 'order_alarm'), so this
  // payload field only ever reaches APNs. iOS resolves it against files
  // bundled into the app and ignores a name it cannot find — a bare
  // 'order_alarm' matched nothing, so iOS shop/rider alarms silently played
  // the default notification sound instead of the alarm.
  describe('iOS custom sound filename', () => {
    const sendWithSound = async (sound) => {
      pool.query.mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]]);
      mockSendPushNotificationsAsync = jest.fn(async () => [{ status: 'ok', id: 't1' }]);
      await sendPushToUser(pool, 42, { title: 'T', body: 'B', sound });
      return mockSendPushNotificationsAsync.mock.calls[0][0][0].sound;
    };

    it('appends the bundled extension to a bare custom sound name', async () => {
      expect(await sendWithSound('order_alarm')).toBe('order_alarm.wav');
    });

    it('leaves "default" untouched', async () => {
      expect(await sendWithSound('default')).toBe('default');
    });

    it('defaults to "default" when no sound is given', async () => {
      expect(await sendWithSound(undefined)).toBe('default');
    });

    it('does not double-append when an extension is already present', async () => {
      expect(await sendWithSound('order_alarm.wav')).toBe('order_alarm.wav');
    });

    it('passes null through so the caller can send a silent push', async () => {
      pool.query.mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]]);
      mockSendPushNotificationsAsync = jest.fn(async () => [{ status: 'ok', id: 't1' }]);
      await sendPushToUser(pool, 42, { title: 'T', body: 'B', sound: null });
      expect(mockSendPushNotificationsAsync.mock.calls[0][0][0]).not.toHaveProperty('sound');
    });
  });
});

describe('expoPush.sendPushToMany', () => {
  it('nulls push_token for every dead ticket in a chunk', async () => {
    // SELECT tokens for userIds
    pool.query
      .mockResolvedValueOnce([[
        { push_token: VALID_TOKEN_A },
        { push_token: VALID_TOKEN_B },
        { push_token: VALID_TOKEN_C },
      ]])
      // UPDATE for VALID_TOKEN_A
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      // UPDATE for VALID_TOKEN_C
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    mockSendPushNotificationsAsync = jest.fn(async () => [
      { status: 'error', details: { error: 'DeviceNotRegistered' } }, // A
      { status: 'ok', id: 't-2' },                                    // B
      { status: 'error', details: { error: 'DeviceNotRegistered' } }, // C
    ]);

    await sendPushToMany(pool, [1, 2, 3], { title: 'Hi', body: 'There' });

    expect(mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);

    const updateCalls = pool.query.mock.calls.filter(
      ([sql]) => /UPDATE users SET push_token = NULL WHERE push_token = \?/i.test(sql)
    );
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0][1]).toEqual([VALID_TOKEN_A]);
    expect(updateCalls[1][1]).toEqual([VALID_TOKEN_C]);
  });

  it('continues to the next chunk when sendPushNotificationsAsync rejects', async () => {
    mockChunkPushNotifications = (messages) => [messages.slice(0, 1), messages.slice(1)];

    pool.query
      // SELECT for all userIds
      .mockResolvedValueOnce([[
        { push_token: VALID_TOKEN_A },
        { push_token: VALID_TOKEN_B },
      ]])
      // First chunk's send rejects — no UPDATE expected for this chunk.
      // Second chunk's UPDATE for VALID_TOKEN_B (DeviceNotRegistered).
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const chunk1Mock = jest.fn(async () => { throw new Error('expo chunk failed'); });
    const chunk2Mock = jest.fn(async () => [
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);
    mockSendPushNotificationsAsync = jest.fn()
      .mockImplementationOnce(chunk1Mock)
      .mockImplementationOnce(chunk2Mock);

    await expect(
      sendPushToMany(pool, [1, 2], { title: 'Hi', body: 'There' })
    ).resolves.toEqual({ recipients: 2, tokensFound: 2, sent: 0, failed: 2 });

    expect(chunk1Mock).toHaveBeenCalledTimes(1);
    expect(chunk2Mock).toHaveBeenCalledTimes(1);

    const updateCalls = pool.query.mock.calls.filter(
      ([sql]) => /UPDATE users SET push_token = NULL WHERE push_token = \?/i.test(sql)
    );
    // Only the second chunk's dead token triggers an UPDATE.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toEqual([VALID_TOKEN_B]);
  });

  it('returns early when userIds is empty', async () => {
    await expect(
      sendPushToMany(pool, [], { title: 'Hi', body: 'There' })
    ).resolves.toEqual({ recipients: 0, tokensFound: 0, sent: 0, failed: 0 });
    expect(pool.query).not.toHaveBeenCalled();
    expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('does not throw when the SELECT itself rejects', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    await expect(
      sendPushToMany(pool, [1, 2, 3], { title: 'Hi', body: 'There' })
    ).resolves.toEqual({ recipients: 3, tokensFound: 0, sent: 0, failed: 0 });

    expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('swallows cleanup errors so they never propagate from sendPushToMany', async () => {
    pool.query
      .mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]])
      .mockRejectedValueOnce(new Error('cleanup write failed'));

    mockSendPushNotificationsAsync = jest.fn(async () => [
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);

    await expect(
      sendPushToMany(pool, [1], { title: 'Hi', body: 'There' })
    ).resolves.toEqual({ recipients: 1, tokensFound: 1, sent: 0, failed: 1 });
  });

  it('tallies mixed tickets into sent/failed counts', async () => {
    pool.query
      .mockResolvedValueOnce([[
        { push_token: VALID_TOKEN_A },
        { push_token: VALID_TOKEN_B },
        { push_token: VALID_TOKEN_C },
      ]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE for the DeviceNotRegistered ticket
    mockSendPushNotificationsAsync = jest.fn(async () => [
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok', id: 't-2' },
      { status: 'error', details: { error: 'MessageTooBig' } },
    ]);

    await expect(
      sendPushToMany(pool, [1, 2, 3], { title: 'Hi', body: 'There' })
    ).resolves.toEqual({ recipients: 3, tokensFound: 3, sent: 1, failed: 2 });
  });

  it('warns and sends nothing when no target users have a valid push token', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    pool.query.mockResolvedValueOnce([[]]); // SELECT returns no rows

    await expect(
      sendPushToMany(pool, [1, 2, 3], { title: 'Hi', body: 'There' })
    ).resolves.toEqual({ recipients: 3, tokensFound: 0, sent: 0, failed: 0 });

    expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('logs InvalidCredentials ticket errors without nulling the token', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    pool.query.mockResolvedValueOnce([[{ push_token: VALID_TOKEN_A }]]); // SELECT only — no UPDATE expected
    mockSendPushNotificationsAsync = jest.fn(async () => [
      { status: 'error', details: { error: 'InvalidCredentials' }, message: 'bad creds' },
    ]);

    await sendPushToMany(pool, [1], { title: 'Hi', body: 'There' });

    expect(mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const loggedInvalidCreds = errorSpy.mock.calls.some(args =>
      args.some(arg => String(arg).includes('InvalidCredentials'))
    );
    expect(loggedInvalidCreds).toBe(true);

    const updateCalls = pool.query.mock.calls.filter(
      ([sql]) => /UPDATE users SET push_token = NULL WHERE push_token = \?/i.test(sql)
    );
    expect(updateCalls).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

describe('expoPush.countPushEligible', () => {
  it('returns the count of users with a non-null push token', async () => {
    pool.query.mockResolvedValueOnce([[{ cnt: 2 }]]);
    await expect(countPushEligible(pool, [1, 2, 3])).resolves.toBe(2);
  });

  it('returns 0 for an empty result set', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(countPushEligible(pool, [1, 2])).resolves.toBe(0);
  });

  it('returns null when the pool query rejects', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(countPushEligible(pool, [1, 2])).resolves.toBeNull();
  });

  it('returns 0 without querying when userIds is empty', async () => {
    await expect(countPushEligible(pool, [])).resolves.toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
