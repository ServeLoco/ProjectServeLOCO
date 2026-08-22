const { createPresenceTracker, SCREEN_WHITELIST } = require('../src/realtime/presence');

// Minimal fake session store + emitter injected into the factory so no Mongo or
// socket.io is needed for unit testing the in-memory presence logic.
const makeDeps = () => ({
  sessionStore: {
    openSession: jest.fn().mockResolvedValue('sess-id-1'),
    closeSession: jest.fn().mockResolvedValue(),
  },
  emitToAdmins: jest.fn(),
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('createPresenceTracker', () => {
  it('exposes the screen whitelist', () => {
    expect(SCREEN_WHITELIST).toContain('Home');
    expect(SCREEN_WHITELIST).toContain('Checkout');
    expect(SCREEN_WHITELIST).toContain('ProductDetail');
    expect(SCREEN_WHITELIST).not.toContain('SearchResults');
  });

  it('addPresence opens a session and stores the Map entry for a customer', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('sock1', { userId: 123, role: 'customer', platform: 'android', appVersion: '1.4.2' });
    expect(deps.sessionStore.openSession).toHaveBeenCalledWith({ userId: 123, platform: 'android', appVersion: '1.4.2' });
    const snap = t.getLiveSnapshot();
    expect(snap.online).toBe(1);
    expect(snap.users).toHaveLength(1);
    expect(snap.users[0]).toMatchObject({ userId: 123, screen: null, platform: 'android' });
  });

  it('does NOT count admin sockets as online users', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('admin-sock', { userId: 1, role: 'admin', platform: null, appVersion: null });
    expect(deps.sessionStore.openSession).not.toHaveBeenCalled();
    const snap = t.getLiveSnapshot();
    expect(snap.online).toBe(0);
    expect(snap.users).toHaveLength(0);
  });

  it('updateScreen updates the Map entry and increments the screen counter', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('sock1', { userId: 123, role: 'customer', platform: 'ios', appVersion: '1.0' });
    t.updateScreen('sock1', 'Home');
    t.updateScreen('sock1', 'Home');
    t.updateScreen('sock1', 'Cart');
    const snap = t.getLiveSnapshot();
    // byScreen counts users currently on each screen (live panel), not visits.
    // User moved Home → Cart, so only Cart should be 1.
    expect(snap.byScreen.Cart).toBe(1);
    expect(snap.users[0].screen).toBe('Cart');
  });

  it('updateScreen ignores non-whitelisted screen names', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('sock1', { userId: 1, role: 'customer', platform: 'ios', appVersion: '1.0' });
    t.updateScreen('sock1', 'SecretScreen');
    const snap = t.getLiveSnapshot();
    expect(snap.byScreen.SecretScreen).toBeUndefined();
    expect(snap.users[0].screen).toBeNull();
  });

  it('updateScreen is a no-op for unknown socketIds', () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    expect(() => t.updateScreen('ghost', 'Home')).not.toThrow();
  });

  it('removePresence closes the session with accumulated screen counts', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('sock1', { userId: 123, role: 'customer', platform: 'android', appVersion: '1.4.2' });
    t.updateScreen('sock1', 'Home');
    t.updateScreen('sock1', 'Home');
    t.updateScreen('sock1', 'Checkout');
    await t.removePresence('sock1');
    expect(deps.sessionStore.closeSession).toHaveBeenCalledTimes(1);
    const [sessionId, screens] = deps.sessionStore.closeSession.mock.calls[0];
    expect(sessionId).toBe('sess-id-1');
    expect(screens).toEqual({ Home: 2, Checkout: 1 });
    expect(t.getLiveSnapshot().online).toBe(0);
  });

  it('removePresence is a no-op for unknown socketIds', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.removePresence('ghost');
    expect(deps.sessionStore.closeSession).not.toHaveBeenCalled();
  });

  it('byPlatform splits android/ios counts (customers only)', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('s1', { userId: 1, role: 'customer', platform: 'android', appVersion: '1' });
    await t.addPresence('s2', { userId: 2, role: 'customer', platform: 'android', appVersion: '1' });
    await t.addPresence('s3', { userId: 3, role: 'customer', platform: 'ios', appVersion: '1' });
    const snap = t.getLiveSnapshot();
    expect(snap.byPlatform).toEqual({ android: 2, ios: 1 });
  });

  it('peakToday tracks the high-water mark and resets on date change', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps, { now: () => new Date('2026-07-09T12:00:00') });
    await t.addPresence('s1', { userId: 1, role: 'customer', platform: 'android', appVersion: '1' });
    await t.addPresence('s2', { userId: 2, role: 'customer', platform: 'ios', appVersion: '1' });
    expect(t.getLiveSnapshot().peakToday).toBe(2);
    await t.removePresence('s1');
    // peak stays at 2 even though online dropped to 1
    expect(t.getLiveSnapshot().peakToday).toBe(2);
  });

  it('emitLiveSnapshot pushes a per-area snapshot to admin:<areaId> via emitToAdmins', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('s1', { userId: 5, role: 'customer', platform: 'android', appVersion: '1.2', areaId: 1 });
    t.updateScreen('s1', 'Checkout');
    await t.emitLiveSnapshot();
    expect(deps.emitToAdmins).toHaveBeenCalledWith(1, 'analytics.live', expect.objectContaining({
      online: 1,
      peakToday: 1,
    }));
    const payload = deps.emitToAdmins.mock.calls[0][2];
    expect(payload.users[0]).toMatchObject({ userId: 5, screen: 'Checkout', platform: 'android' });
    expect(payload.users[0].connectedMin).toBeDefined();
  });

  it('emitLiveSnapshot skips the emit entirely when no presence entry has an areaId (NODE_ENV=test skips the listAreas union)', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('s1', { userId: 5, role: 'customer', platform: 'android', appVersion: '1.2' });
    await t.emitLiveSnapshot();
    expect(deps.emitToAdmins).not.toHaveBeenCalled();
  });

  it('getLiveSnapshot returns empty/zero state when nobody is online', () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    const snap = t.getLiveSnapshot();
    expect(snap).toEqual({
      online: 0,
      peakToday: 0,
      byScreen: {},
      byPlatform: { android: 0, ios: 0 },
      byArea: {},
      users: [],
    });
  });

  it('connectedMin reflects minutes since connect', async () => {
    const deps = makeDeps();
    const start = new Date('2026-07-09T12:00:00');
    const clock = { now: () => start };
    const t = createPresenceTracker(deps, { now: () => clock.now() });
    await t.addPresence('s1', { userId: 1, role: 'customer', platform: 'android', appVersion: '1' });
    // advance 7 minutes
    clock.now = () => new Date('2026-07-09T12:07:00');
    const snap = t.getLiveSnapshot();
    expect(snap.users[0].connectedMin).toBe(7);
  });

  // Regression: a socket that disconnected while openSession was still in
  // flight used to be re-inserted into the Map after the fact, producing an
  // "online" user that no code path could ever remove.
  it('a disconnect during openSession leaves no phantom entry', async () => {
    const deps = makeDeps();
    let releaseOpenSession;
    deps.sessionStore.openSession = jest.fn(
      () => new Promise((resolve) => { releaseOpenSession = () => resolve('sess-late'); })
    );
    const t = createPresenceTracker(deps);

    const adding = t.addPresence('sock1', { userId: 7, role: 'customer', platform: 'android', appVersion: '1', areaId: 1 });
    // Entry is visible immediately, before the Mongo write resolves.
    expect(t.getLiveSnapshot().online).toBe(1);

    await t.removePresence('sock1');
    expect(t.getLiveSnapshot().online).toBe(0);

    releaseOpenSession();
    await adding;

    expect(t.getLiveSnapshot().online).toBe(0);
    // The doc openSession created still has to be closed, or it stays open forever.
    expect(deps.sessionStore.closeSession).toHaveBeenCalledWith('sess-late', {}, expect.any(Date));
  });

  it('reapDeadSockets drops entries whose socket is no longer connected', async () => {
    const deps = makeDeps();
    const liveSockets = new Set(['s1', 's2']);
    const t = createPresenceTracker({ ...deps, isSocketAlive: (id) => liveSockets.has(id) });
    await t.addPresence('s1', { userId: 1, role: 'customer', platform: 'android', appVersion: '1', areaId: 1 });
    await t.addPresence('s2', { userId: 2, role: 'customer', platform: 'ios', appVersion: '1', areaId: 1 });
    expect(t.getLiveSnapshot().online).toBe(2);

    // Socket vanished without ever emitting 'disconnect'.
    liveSockets.delete('s2');
    await t.emitLiveSnapshot();
    await wait(0);

    expect(t.getLiveSnapshot().online).toBe(1);
    expect(deps.sessionStore.closeSession).toHaveBeenCalledTimes(1);
  });

  it('the reaper stays inert when no isSocketAlive probe is injected', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps);
    await t.addPresence('s1', { userId: 1, role: 'customer', platform: 'android', appVersion: '1', areaId: 1 });
    await t.emitLiveSnapshot();
    await wait(0);
    expect(t.getLiveSnapshot().online).toBe(1);
    expect(deps.sessionStore.closeSession).not.toHaveBeenCalled();
  });

  it('stop clears the interval timer', async () => {
    const deps = makeDeps();
    const t = createPresenceTracker(deps, { intervalMs: 10 });
    await t.addPresence('s1', { userId: 1, role: 'customer', platform: 'android', appVersion: '1', areaId: 1 });
    await wait(35);
    expect(deps.emitToAdmins.mock.calls.length).toBeGreaterThan(0);
    const callsBefore = deps.emitToAdmins.mock.calls.length;
    t.stop();
    await wait(35);
    expect(deps.emitToAdmins.mock.calls.length).toBe(callsBefore);
  });
});
