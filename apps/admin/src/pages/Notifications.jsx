import React, { useState, useEffect, useMemo } from 'react';
import { NotificationsApi, NotificationTemplatesApi } from '../api';
import './Notifications.css';

const EMOJI_SUGGESTIONS = {
  info: ['ℹ️', '📢', '📣', '💡', '📌', '🔔'],
  offer: ['🎉', '🎊', '🔥', '⚡', '💰', '🎁', '🏷️', '💸', '✨'],
  success: ['✅', '🎊', '👍', '💚', '🌟', '🎯'],
  warning: ['⚠️', '❗', '🚨', '⛔', '❌'],
  admin: ['👨‍💼', '📋', '🔧', '⚙️', '📊']
};

const QUICK_TEMPLATES = [
  { title: '🎉 Flash Sale Alert!', body: 'Limited time offer! Get 20% off on all orders today. Order now!', type: 'offer' },
  { title: '🔥 New Items Added!', body: 'Check out our latest menu additions. Fresh and delicious!', type: 'info' },
  { title: '⚡ Free Delivery Today!', body: 'Enjoy free delivery on all orders above ₹199. Valid today only!', type: 'offer' },
  { title: '⚠️ Shop Closing Early', body: 'We will be closing at 8 PM today. Place your orders early!', type: 'warning' },
  { title: '🎊 Thank You!', body: 'Thank you for being our valued customer. Enjoy 10% off your next order!', type: 'success' }
];

import { GENERIC_ERROR } from '../utils/constants';

const EVENT_LABELS = {
  order_placed:           { label: 'Order Placed',        icon: '🎉', trigger: 'When customer places an order' },
  status_accepted:        { label: 'Order Accepted',       icon: '✅', trigger: 'When admin accepts an order' },
  status_preparing:       { label: 'Preparing',            icon: '👨‍🍳', trigger: 'When admin marks as Preparing' },
  status_out_for_delivery:{ label: 'Out for Delivery',     icon: '🚚', trigger: 'When admin marks as Out for Delivery' },
  status_delivered:       { label: 'Delivered',            icon: '🎊', trigger: 'When admin marks as Delivered' },
  status_cancelled:       { label: 'Order Cancelled',      icon: '❌', trigger: 'When order is cancelled (by admin or customer)' },
  payment_paid:           { label: 'Payment Received',     icon: '💰', trigger: 'When admin marks payment as Paid' },
  payment_failed:         { label: 'Payment Failed',       icon: '⚠️', trigger: 'When admin marks payment as Failed' },
  payment_refunded:       { label: 'Payment Refunded',     icon: '💸', trigger: 'When admin marks payment as Refunded' },
};

export default function Notifications() {
  const [broadcasts, setBroadcasts] = useState([]);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [type, setType] = useState('info');
  const [target, setTarget] = useState('everyone');
  const [phonesInput, setPhonesInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiTarget, setEmojiTarget] = useState('title'); // 'title' or 'body'

  // Parse + normalise the phones textarea so we can preview how many will be sent.
  const parsedPhones = useMemo(() => {
    if (target !== 'phones') return [];
    const seen = new Set();
    const out = [];
    for (const raw of String(phonesInput || '').split(/[\s,;]+/)) {
      const cleaned = String(raw || '').replace(/[^\d+]/g, '');
      const normalized = cleaned.startsWith('+') ? `+${cleaned.slice(1).replace(/\D/g, '')}` : cleaned.replace(/\D/g, '');
      if (!normalized || normalized.length < 7) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }, [phonesInput, target]);

  useEffect(() => {
    fetchBroadcasts();
    fetchTemplates();
  }, []);

  const fetchBroadcasts = async () => {
    setLoading(true);
    try {
      const res = await NotificationsApi.list();
      setBroadcasts(res.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const res = await NotificationTemplatesApi.list();
      setTemplates(res.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) {
      setErrorMsg('Title and body are required');
      return;
    }

    if (title.length > 80) {
      setErrorMsg('Title must be 80 characters or less');
      return;
    }

    if (body.length > 240) {
      setErrorMsg('Body must be 240 characters or less');
      return;
    }

    if (target === 'phones' && parsedPhones.length === 0) {
      setErrorMsg('Enter at least one phone number to send to specific customers');
      return;
    }

    const targetDescription =
      target === 'everyone'
        ? 'all active customers'
        : `${parsedPhones.length} customer${parsedPhones.length === 1 ? '' : 's'} by phone`;

    if (!window.confirm(`Are you sure you want to send this broadcast to ${targetDescription}?`)) {
      return;
    }

    setIsSending(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const payload = { title, body, type, target };
      if (target === 'phones') payload.phones = parsedPhones;

      const res = await NotificationsApi.create(payload);
      const recipientCount = res?.data?.recipientCount ?? 'all';
      const matched = res?.data?.matchedPhones;
      const unmatched = res?.data?.unmatchedPhones;
      const pushEligible = res?.data?.pushEligibleCount;
      let pushHint = '';
      if (typeof pushEligible === 'number') {
        pushHint = pushEligible === 0
          ? ' ⚠️ Saved to in-app inboxes, but none of these customers have a push-capable device — no phone notifications will be delivered.'
          : ` — ${pushEligible} have push-capable devices (others will see it in-app)`;
      }

      const matchedHint = Array.isArray(matched) && matched.length
        ? ` (matched: ${matched.join(', ')})`
        : '';
      const unmatchedHint = Array.isArray(unmatched) && unmatched.length
        ? ` ⚠️ ${unmatched.length} numbers not found: ${unmatched.join(', ')}`
        : '';
      setSuccessMsg(`✅ Sent successfully to ${recipientCount} customer${recipientCount === 1 ? '' : 's'}!${matchedHint}${unmatchedHint}${pushHint}`);
      setTitle('');
      setBody('');
      setPhonesInput('');
      fetchBroadcasts();
    } catch (err) {
      console.error(err);
      const apiMsg = err?.response?.data?.message;
      setErrorMsg(apiMsg || GENERIC_ERROR);
    } finally {
      setIsSending(false);
    }
  };

  const [deletingId, setDeletingId] = useState(null);

  // ── Notification templates ──────────────────────────────────────────────
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', body: '' });
  const [savingTemplateId, setSavingTemplateId] = useState(null);
  const [resettingTemplateId, setResettingTemplateId] = useState(null);
  const [togglingTemplateId, setTogglingTemplateId] = useState(null);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this broadcast? It will be removed from customer inboxes.')) return;
    setDeletingId(id);
    try {
      await NotificationsApi.delete(id);
      setBroadcasts(prev => prev.filter(b => b.id !== id));
    } catch (err) {
      console.error(err);
      setErrorMsg(err?.response?.data?.message || err?.message || GENERIC_ERROR);
    } finally {
      setDeletingId(null);
    }
  };

  const insertEmoji = (emoji) => {
    if (emojiTarget === 'title') {
      setTitle(prev => prev + emoji);
    } else {
      setBody(prev => prev + emoji);
    }
    setShowEmojiPicker(false);
  };

  const applyTemplate = (template) => {
    if ((title || body) && !window.confirm('Replace your current message with this template?')) return;
    setTitle(template.title);
    setBody(template.body);
    setType(template.type);
    setErrorMsg('');
    setSuccessMsg('');
  };

  const handleTemplateEditStart = (tmpl) => {
    setEditingTemplateId(tmpl.id);
    setEditForm({ title: tmpl.title, body: tmpl.body });
  };

  const handleTemplateEditCancel = () => {
    setEditingTemplateId(null);
    setEditForm({ title: '', body: '' });
  };

  const handleTemplateEditSave = async (tmpl) => {
    if (!editForm.title.trim() || !editForm.body.trim()) return;
    setSavingTemplateId(tmpl.id);
    try {
      const res = await NotificationTemplatesApi.update(tmpl.id, {
        title: editForm.title.trim(),
        body: editForm.body.trim(),
        enabled: tmpl.enabled,
      });
      setTemplates(prev => prev.map(t => t.id === tmpl.id ? res.data : t));
      setEditingTemplateId(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingTemplateId(null);
    }
  };

  const handleTemplateReset = async (tmpl) => {
    if (!window.confirm(`Reset "${EVENT_LABELS[tmpl.event_key]?.label}" to its default text?`)) return;
    setResettingTemplateId(tmpl.id);
    try {
      const res = await NotificationTemplatesApi.reset(tmpl.id);
      setTemplates(prev => prev.map(t => t.id === tmpl.id ? res.data : t));
      if (editingTemplateId === tmpl.id) setEditingTemplateId(null);
    } catch (err) {
      console.error(err);
    } finally {
      setResettingTemplateId(null);
    }
  };

  const handleTemplateToggle = async (tmpl) => {
    setTogglingTemplateId(tmpl.id);
    try {
      const res = await NotificationTemplatesApi.update(tmpl.id, {
        title: tmpl.title,
        body: tmpl.body,
        enabled: tmpl.enabled ? 0 : 1,
      });
      setTemplates(prev => prev.map(t => t.id === tmpl.id ? res.data : t));
    } catch (err) {
      console.error(err);
    } finally {
      setTogglingTemplateId(null);
    }
  };

  return (
    <div className="notifications-page">
      <header className="page-header">
        <h1 className="page-title">📢 Broadcast Notifications</h1>
        <p className="page-subtitle">Send instant notifications to all your customers</p>
      </header>

      <div className="notifications-content">
        <div className="compose-section card">
          <h2>✨ Send New Broadcast</h2>

          {errorMsg && <div className="inline-error-box">❌ {errorMsg}</div>}
          {successMsg && <div className="inline-success-box">{successMsg}</div>}

          {/* Quick Templates */}
          <div className="quick-templates">
            <label className="templates-label">Quick Templates:</label>
            <div className="template-chips">
              {QUICK_TEMPLATES.map((template, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="template-chip"
                  onClick={() => applyTemplate(template)}
                  title={template.body}
                >
                  {template.title}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSend} className="compose-form">
            <div className="form-row">
              <div className="form-group">
                <label>Target Audience</label>
                <select value={target} onChange={e => setTarget(e.target.value)}>
                  <option value="everyone">👥 All Active Customers</option>
                  <option value="phones">📱 Specific Phone Numbers</option>
                </select>
              </div>

              <div className="form-group">
                <label>Notification Type</label>
                <select value={type} onChange={e => setType(e.target.value)}>
                  <option value="info">ℹ️ Info</option>
                  <option value="offer">🎁 Offer / Promotion</option>
                  <option value="success">✅ Success</option>
                  <option value="warning">⚠️ Warning / Alert</option>
                  <option value="admin">👨‍💼 Admin Update</option>
                </select>
              </div>
            </div>

            {target === 'phones' && (
              <div className="form-group phones-target-group">
                <label>
                  Phone Numbers
                  <small>
                    {parsedPhones.length === 0
                      ? ' — enter at least one phone, separated by commas or new lines'
                      : ` — ${parsedPhones.length} valid phone${parsedPhones.length === 1 ? '' : 's'} parsed`}
                  </small>
                </label>
                <textarea
                  className="phones-textarea"
                  rows={4}
                  value={phonesInput}
                  onChange={e => setPhonesInput(e.target.value)}
                  placeholder={'9999999001, 9999999002\n+91 9999999003'}
                />
                <div className="phones-preview">
                  {parsedPhones.length > 0 ? (
                    <span>Will send to: <strong>{parsedPhones.join(', ')}</strong></span>
                  ) : (
                    <span className="muted">No valid numbers yet — they must be 7+ digits.</span>
                  )}
                </div>
              </div>
            )}

            <div className="form-group">
              <label>Title <small>(Max 80 chars)</small></label>
              <div className="input-with-emoji">
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  maxLength={80}
                  placeholder="e.g. 🎉 Flash Sale Today!"
                />
                <button
                  type="button"
                  className="emoji-btn"
                  onClick={() => {
                    setEmojiTarget('title');
                    setShowEmojiPicker(!showEmojiPicker);
                  }}
                  title="Add emoji"
                >
                  😊
                </button>
              </div>
            </div>

            <div className="form-group">
              <label>Body <small>({body.length}/240 chars)</small></label>
              <div className="input-with-emoji">
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  maxLength={240}
                  placeholder="Type your message here..."
                  rows={4}
                />
                <button
                  type="button"
                  className="emoji-btn"
                  onClick={() => {
                    setEmojiTarget('body');
                    setShowEmojiPicker(!showEmojiPicker);
                  }}
                  title="Add emoji"
                >
                  😊
                </button>
              </div>
            </div>

            {showEmojiPicker && (
              <div className="emoji-picker">
                <div className="emoji-picker-header">
                  <span>Suggested for {type}</span>
                  <button type="button" onClick={() => setShowEmojiPicker(false)}>✕</button>
                </div>
                <div className="emoji-grid">
                  {EMOJI_SUGGESTIONS[type]?.map((emoji, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="emoji-item"
                      onClick={() => insertEmoji(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Preview */}
            {(title || body) && (
              <div className="notification-preview">
                <label>📱 Preview (How it will look on phone)</label>
                <div className="preview-phone">
                  <div className="preview-notification">
                    <div className="preview-app-icon">🍽️</div>
                    <div className="preview-content">
                      <div className="preview-title">{title || 'Notification Title'}</div>
                      <div className="preview-body">{body || 'Notification message will appear here'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <button type="submit" className="btn btn-primary btn-send" disabled={isSending}>
              {isSending ? '📤 Sending...' : '📤 Send Broadcast'}
            </button>
          </form>
        </div>

        <div className="history-section card">
          <h2>📋 Recent Broadcasts</h2>
          {loading ? (
            <p>Loading...</p>
          ) : broadcasts.length === 0 ? (
            <p className="empty-text">No recent broadcasts found.</p>
          ) : (
            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Title & Body</th>
                    <th>Recipients</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {broadcasts.map(b => (
                    <tr key={b.id}>
                      <td>{new Date(b.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                      <td>
                        <span className={`badge badge-${b.type}`}>{b.type}</span>
                      </td>
                      <td>
                        <strong>{b.title}</strong>
                        <div className="text-muted text-sm">{b.body}</div>
                      </td>
                      <td>{b.recipient_count}</td>
                      <td>
                        <button
                          className="btn btn-sm btn-danger-text"
                          onClick={() => handleDelete(b.id)}
                          disabled={deletingId === b.id}
                        >
                          {deletingId === b.id ? '⏳ Deleting…' : '🗑️ Delete'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Auto-send notification templates ──────────────────────────── */}
      <div className="templates-section card">
        <h2>⚙️ Auto-Send Notification Templates</h2>
        <p className="templates-subtitle">
          These messages are sent automatically when order or payment status changes.
          Edit the text, toggle them on/off, or reset to the original default.
        </p>

        {templatesLoading ? (
          <p>Loading templates…</p>
        ) : (
          <div className="templates-list">
            {templates.map(tmpl => {
              const meta = EVENT_LABELS[tmpl.event_key] || { label: tmpl.event_key, icon: '🔔', trigger: '' };
              const isEditing = editingTemplateId === tmpl.id;
              const isSaving = savingTemplateId === tmpl.id;
              const isResetting = resettingTemplateId === tmpl.id;
              const isToggling = togglingTemplateId === tmpl.id;

              return (
                <div key={tmpl.id} className={`template-row${!tmpl.enabled ? ' template-disabled' : ''}`}>
                  <div className="template-header">
                    <div className="template-identity">
                      <span className="template-icon">{meta.icon}</span>
                      <div className="template-meta">
                        <span className="template-event-name">{meta.label}</span>
                        <span className="template-trigger">{meta.trigger}</span>
                        {!isEditing && (
                          <div className="template-preview">
                            <strong>{tmpl.title}</strong>
                            <span className="template-preview-body"> — {tmpl.body}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="template-actions">
                      <label className={`toggle-switch${isToggling ? ' toggle-busy' : ''}`} title={tmpl.enabled ? 'Disable this notification' : 'Enable this notification'}>
                        <input
                          type="checkbox"
                          checked={Boolean(tmpl.enabled)}
                          onChange={() => handleTemplateToggle(tmpl)}
                          disabled={isToggling}
                        />
                        <span className="toggle-slider" />
                      </label>

                      {isEditing ? (
                        <button className="btn btn-sm btn-secondary" onClick={handleTemplateEditCancel}>
                          Cancel
                        </button>
                      ) : (
                        <button className="btn btn-sm btn-outline" onClick={() => handleTemplateEditStart(tmpl)}>
                          ✏️ Edit
                        </button>
                      )}

                      <button
                        className="btn btn-sm btn-ghost-warning"
                        onClick={() => handleTemplateReset(tmpl)}
                        disabled={isResetting}
                        title="Reset to default text"
                      >
                        {isResetting ? '⏳' : '↺ Default'}
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <div className="template-edit-form">
                      <div className="form-row">
                        <div className="form-group">
                          <label>Title <small>(Max 80 chars — {editForm.title.length}/80)</small></label>
                          <input
                            type="text"
                            value={editForm.title}
                            onChange={e => setEditForm(prev => ({ ...prev, title: e.target.value }))}
                            maxLength={80}
                            placeholder="Notification title"
                          />
                        </div>
                        <div className="form-group template-preview-phone-wrap">
                          <label>📱 Preview</label>
                          <div className="preview-phone template-preview-phone">
                            <div className="preview-notification">
                              <div className="preview-app-icon">🍽️</div>
                              <div className="preview-content">
                                <div className="preview-title">{editForm.title || 'Title'}</div>
                                <div className="preview-body">{editForm.body || 'Body…'}</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Body <small>({editForm.body.length}/240 chars)</small></label>
                        <textarea
                          value={editForm.body}
                          onChange={e => setEditForm(prev => ({ ...prev, body: e.target.value }))}
                          maxLength={240}
                          rows={3}
                          placeholder="Notification body"
                        />
                      </div>

                      <div className="template-edit-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleTemplateEditSave(tmpl)}
                          disabled={isSaving || !editForm.title.trim() || !editForm.body.trim()}
                        >
                          {isSaving ? '⏳ Saving…' : '💾 Save'}
                        </button>
                        <button className="btn btn-sm btn-secondary" onClick={handleTemplateEditCancel}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
