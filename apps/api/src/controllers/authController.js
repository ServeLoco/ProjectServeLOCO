const { pool } = require('../db/mysql');
const { signCustomerToken, verifyToken } = require('../utils/auth');
const { getFirebaseAuth } = require('../config/firebase');
const adminInbox = require('../utils/adminNotifications');
const { getShopForUser } = require('../utils/shops');
const { getRiderForUser } = require('../utils/riders');
const { getMobileAdminForUser } = require('../utils/mobileAdmins');
const { getDefaultArea } = require('../utils/areaScope');

// Sliding-window token renewal. We refresh whenever the token has used
// more than half of its own lifetime. This auto-adapts to whatever
// JWT_EXPIRES_IN is configured to: a 30d token refreshes after 15d, a 1d
// token refreshes after 12h, etc. That way a misconfigured short expiry
// doesn't silently strand users — the app re-arms the token on every
// /auth/me call inside the second half of its life.
//
// We also keep an absolute floor (24h) so very long-lived tokens still
// get rotated periodically and don't ride out their entire lifetime
// without ever passing through the server.
const TOKEN_REFRESH_FLOOR_SECONDS = 24 * 60 * 60;

const me = async (req, res) => {
  const userId = req.user.id;

  const [rows] = await pool.query(
    'SELECT id, name, phone, whatsapp_number, address, trusted, blocked, deletion_requested_at, created_at FROM users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
  }

  const user = rows[0];

  // Sliding token refresh — if the current JWT is past the midpoint of
  // its own lifetime (or within the absolute floor of expiry), issue a
  // fresh one so the client can silently renew without re-login. The
  // midpoint rule makes the refresh window scale with whatever
  // JWT_EXPIRES_IN is set to in production.
  const response = { user };
  response.shop = await getShopForUser(userId);
  response.rider = await getRiderForUser(userId);
  // Pass phone so first-login after web add (user_id still null) still attaches admin.
  response.admin = await getMobileAdminForUser(userId, user.phone);
  // D2: one phone is shop OR rider, not both. If corrupt data has both, log once.
  if (response.shop && response.rider) {
    console.warn('[auth] user', userId, 'has both shop and rider rows — mutual exclusion violated');
  }
  try {
    const authHeader = req.headers.authorization || '';
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (rawToken) {
      const decoded = verifyToken(rawToken);
      const nowSec = Math.floor(Date.now() / 1000);
      const exp = decoded.exp || 0;
      const iat = decoded.iat || 0;
      const remaining = exp - nowSec;
      const lifetime = exp - iat;
      // Refresh when:
      //   (a) we're past the midpoint of this token's lifetime, OR
      //   (b) less than TOKEN_REFRESH_FLOOR_SECONDS remain.
      // The `remaining > 0` guard skips already-dead tokens (middleware
      // would have rejected them, but defensive).
      const pastMidpoint = lifetime > 0 && remaining < lifetime / 2;
      const nearFloor = remaining < TOKEN_REFRESH_FLOOR_SECONDS;
      if (remaining > 0 && (pastMidpoint || nearFloor)) {
        response.token = signCustomerToken(userId);
      }
    }
  } catch (_) {
    // Token is still valid (middleware already checked), but if decode fails
    // here for any reason just skip the refresh — not critical.
  }

  res.status(200).json(response);
};

const updateProfile = async (req, res) => {
  const userId = req.user.id;
  const { name, address, whatsapp_number } = req.validatedData;

  await pool.query(
    'UPDATE users SET name = ?, address = ?, whatsapp_number = ? WHERE id = ?',
    [name, address, whatsapp_number, userId]
  );

  const [rows] = await pool.query('SELECT id, name, phone, whatsapp_number, address, trusted, blocked FROM users WHERE id = ?', [userId]);

  res.status(200).json({
    message: 'Profile updated successfully',
    user: rows[0]
  });
};

// Soft-delete the customer account: wipe PII, block further logins.
// Soft-delete with a 30-day grace period. Marks the account for deletion
// and signs the user out. A separate cron
// (see server.js) hard-deletes accounts where deletion_requested_at is older
// than 30 days. The `requireCustomer` middleware also blocks any token
// whose user has blocked=1, so any in-flight JWT becomes unusable once we
// flip the flag — but we deliberately do NOT flip blocked=1 here, so the
// user can keep using the app during the grace period to change their mind.
const DELETION_GRACE_DAYS = 30;

const requestAccountDeletion = async (req, res) => {
  const userId = req.user.id;

  const [rows] = await pool.query(
    'SELECT id, firebase_uid, deletion_requested_at FROM users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Account not found' });
  }

  // Allow re-confirmation — overwrites the previous timestamp (grace period
  // restarts from "now"). The user explicitly asked for 30 days, so we honour
  // that even if they previously scheduled then cancelled.
  await pool.query(
    'UPDATE users SET deletion_requested_at = NOW() WHERE id = ?',
    [userId]
  );

  res.status(200).json({
    success: true,
    message: `Your account will be deleted automatically in ${DELETION_GRACE_DAYS} days. You can cancel anytime from your Profile.`,
    graceDays: DELETION_GRACE_DAYS,
    deletionRequestedAt: new Date().toISOString(),
  });
};

// Cancel a previously scheduled deletion (used by the "Cancel deletion" UI).
const cancelAccountDeletion = async (req, res) => {
  const userId = req.user.id;
  await pool.query(
    'UPDATE users SET deletion_requested_at = NULL, deletion_reason = NULL WHERE id = ?',
    [userId]
  );
  res.status(200).json({ success: true, message: 'Account deletion cancelled.' });
};

const { Expo } = require('expo-server-sdk');

const registerPushToken = async (req, res) => {
  const userId = req.user.id;
  const token = req.body?.push_token || req.body?.pushToken;
  const fcmToken = req.body?.fcm_token || req.body?.fcmToken || null;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'push_token is required' });
  }

  if (!Expo.isExpoPushToken(token)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid Expo push token format' });
  }

  // Detach this token from any OTHER account first. On a shared device the
  // previous user's row can still hold the same Expo token — without this,
  // they would keep receiving the new user's order notifications.
  await pool.query('UPDATE users SET push_token = NULL WHERE push_token = ? AND id != ?', [token, userId]);
  await pool.query('UPDATE users SET push_token = ? WHERE id = ?', [token, userId]);

  // Optional native FCM token for shop/rider data-only killed-app alarms.
  if (fcmToken && typeof fcmToken === 'string' && fcmToken.length >= 20) {
    await pool.query('UPDATE users SET fcm_token = NULL WHERE fcm_token = ? AND id != ?', [fcmToken, userId]);
    await pool.query('UPDATE users SET fcm_token = ? WHERE id = ?', [fcmToken, userId]);
  }

  res.json({ success: true });
};

// Customer logout — only clears the push token so this device stops
// receiving the account's notifications. The JWT itself stays valid until
// expiry (no revocation store — out of scope, see plans/bugs.md TASK 4).
const logout = async (req, res) => {
  const userId = req.user.id;
  await pool.query('UPDATE users SET push_token = NULL, fcm_token = NULL WHERE id = ?', [userId]);
  res.status(200).json({ data: { ok: true } });
};

/**
 * Firebase Phone Auth — verify the Firebase ID token sent by the client
 * after the user completes OTP verification on the client side.
 *
 * Flow:
 *   1. Client uses Firebase SDK to send OTP, user enters 6-digit code.
 *   2. Firebase verifies code → client gets a Firebase ID token.
 *   3. Client POSTs { idToken, name? } to this endpoint.
 *   4. Backend verifies idToken with Firebase Admin SDK.
 *   5. Backend finds user by phone or creates a new one (signup).
 *   6. Backend issues its own JWT.
 *
 * For login:  POST /auth/firebase-verify  { idToken }
 * For signup: POST /auth/firebase-verify  { idToken, name }
 */
const verifyFirebaseToken = async (req, res) => {
  const { idToken, name } = req.body || {};

  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Firebase ID token is required' });
  }

  const firebaseAuth = getFirebaseAuth();
  if (!firebaseAuth) {
    return res.status(500).json({ code: 'SERVER_ERROR', message: 'Firebase is not configured on this server' });
  }

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(idToken);
  } catch (err) {
    console.error('[firebase] verifyIdToken error:', err.code || err.message);
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired Firebase token' });
  }

  // Extract the phone number from the verified token.
  const phone = decoded.phone_number;
  if (!phone) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Firebase token does not contain a phone number' });
  }

  // Only Indian (+91) phone numbers are supported. Reject anything else
  // before we touch the database — including +1 (US), +44 (UK), etc.
  if (!phone.startsWith('+91')) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Only Indian phone numbers (+91) are supported' });
  }

  const firebaseUid = decoded.uid;

  // Normalize phone: strip +91 prefix if present, keep last 10 digits.
  const normalizedPhone = phone.replace(/^\+91/, '').replace(/\D/g, '').slice(-10);

  if (normalizedPhone.length !== 10) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid phone number in Firebase token' });
  }

  // Look up user by phone.
  const [existing] = await pool.query(
    'SELECT id, name, phone, whatsapp_number, address, trusted, blocked, firebase_uid, created_at FROM users WHERE phone = ?',
    [normalizedPhone]
  );

  let user;
  let isNewUser = false;

  if (existing.length > 0) {
    // Existing user — login flow.
    user = existing[0];

    if (user.blocked) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Your account is blocked' });
    }

    // Link Firebase UID if not already linked.
    if (!user.firebase_uid) {
      await pool.query('UPDATE users SET firebase_uid = ? WHERE id = ?', [firebaseUid, user.id]);
    }
  } else {
    // New user — signup flow. Name is required for new users.
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        code: 'NAME_REQUIRED',
        message: 'Name is required for new users',
        isNewUser: true,
      });
    }

    const trimmedName = name.trim();
    let userId;
    try {
      const [result] = await pool.query(
        'INSERT INTO users (name, phone, firebase_uid) VALUES (?, ?, ?)',
        [trimmedName, normalizedPhone, firebaseUid]
      );
      userId = result.insertId;
    } catch (insertErr) {
      // ER_DUP_ENTRY (MySQL errno 1062) can happen when two simultaneous
      // OTP verifies for the same new phone race past the SELECT above.
      // Re-query the existing user and continue the login flow instead of
      // leaking the raw SQL error to the client.
      const isDuplicate =
        insertErr &&
        (insertErr.code === 'ER_DUP_ENTRY' || insertErr.errno === 1062);
      if (!isDuplicate) throw insertErr;

      const [raceWinner] = await pool.query(
        'SELECT id, name, phone, whatsapp_number, address, trusted, blocked, firebase_uid, created_at FROM users WHERE phone = ?',
        [normalizedPhone]
      );
      // Vanishingly unlikely (row deleted between the INSERT failure and the
      // re-SELECT), but don't leak the raw MySQL error if it does happen.
      if (raceWinner.length === 0) {
        console.error('[auth] ER_DUP_ENTRY but row vanished on re-query:', insertErr.code || insertErr.message);
        return res.status(409).json({ code: 'CONFLICT', message: 'Account state changed during request. Please try again.' });
      }

      const existingUser = raceWinner[0];
      if (existingUser.blocked) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Your account is blocked' });
      }
      if (!existingUser.firebase_uid) {
        await pool.query('UPDATE users SET firebase_uid = ? WHERE id = ?', [firebaseUid, existingUser.id]);
      }

      // Issue the session inline and return — we don't fall through to the
      // new-user branch below since that would re-insert or fire a duplicate
      // admin notification.
      const raceToken = signCustomerToken(existingUser.id);
      const raceShop = await getShopForUser(existingUser.id);
      const raceRider = await getRiderForUser(existingUser.id);
      const raceAdmin = await getMobileAdminForUser(existingUser.id, existingUser.phone);
      return res.status(200).json({
        message: 'Login successful',
        token: raceToken,
        shop: raceShop,
        rider: raceRider,
        admin: raceAdmin,
        user: {
          id: existingUser.id,
          name: existingUser.name,
          phone: existingUser.phone,
          whatsapp_number: existingUser.whatsapp_number,
          address: existingUser.address,
          trusted: existingUser.trusted,
          blocked: existingUser.blocked,
          created_at: existingUser.created_at,
        },
      });
    }
    isNewUser = true;

    // Admin inbox — fire-and-forget notification on new customer signup.
    // No pin/location exists at signup time to resolve a real area from —
    // the default area is the same fallback resolveCustomerArea itself uses
    // for "no pin, no order history" (§4.2), not a guess invented here.
    const signupAreaId = (await getDefaultArea())?.id;
    adminInbox.createAdminNotification({
      type: adminInbox.TYPES.NEW_CUSTOMER,
      title: 'New customer signed up',
      body: `${trimmedName} (${normalizedPhone}) just created an account via OTP`,
      relatedUrl: `/customers?id=${userId}`,
      relatedId: String(userId),
      areaId: signupAreaId,
    });

    user = {
      id: userId,
      name: trimmedName,
      phone: normalizedPhone,
      whatsapp_number: null,
      address: null,
      trusted: 0,
      blocked: 0,
      created_at: new Date(),
    };
  }

  const token = signCustomerToken(user.id);

  const shop = await getShopForUser(user.id);
  const rider = await getRiderForUser(user.id);
  // Pass phone so first-login after web add (user_id still null) still attaches admin.
  const admin = await getMobileAdminForUser(user.id, user.phone);
  if (shop && rider) {
    console.warn('[auth] user', user.id, 'has both shop and rider rows — mutual exclusion violated');
  }

  res.status(isNewUser ? 201 : 200).json({
    message: isNewUser ? 'Registration successful' : 'Login successful',
    token,
    shop,
    rider,
    admin,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      whatsapp_number: user.whatsapp_number,
      address: user.address,
      trusted: user.trusted,
      blocked: user.blocked,
      created_at: user.created_at,
    },
  });
};

module.exports = {
  me,
  updateProfile,
  requestAccountDeletion,
  cancelAccountDeletion,
  registerPushToken,
  logout,
  verifyFirebaseToken,
};
