import React, { useState, useEffect, useRef } from 'react';
import { SettingsApi, ImagesApi } from '../api';
import { getUploadedImage, normalizeImageUrl } from '../utils/imageUrl';
import { IMAGE_GUIDANCE } from '../utils/imageGuidance';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import './Settings.css';
import { GENERIC_ERROR } from '../utils/constants';
import MessageBanner from '../components/MessageBanner';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';

const DEFAULT_SETTINGS = {
  shop_open: false,
  delivery_available: false,
  delivery_charge: 0,
  night_charge: 0,
  night_charge_start: '',
  night_charge_end: '',
  rain_charge_enabled: false,
  rain_charge: 0,
  fast_delivery_enabled: false,
  fast_delivery_charge: 0,
  standard_delivery_minutes: 60,
  fast_delivery_minutes: 30,
  whatsapp_number: '',
  support_phone: '',
  upi_id: '',
  upi_qr_image_id: '',
  upi_qr_image_url: '',
  minimum_version: '',
  current_version: ''
  // Location-based distance pricing is removed, so latitude/longitude/radius are obsolete.
};

export default function Settings() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [error, setError] = useState(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadMessage, setUploadMessage] = useState(null);
  const [formError, setFormError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const fileInputRef = useRef(null);
  const savedImageIdRef = useRef('');

  useEffect(() => {
    // 25.4 — Settings can't be shown/managed for "all" areas at once (§2.10);
    // skip the doomed 400 fetch and render the inline notice instead.
    if (isAllAreas) {
      setLoading(false);
      return;
    }
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAllAreas]);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const res = await SettingsApi.get();
      if (res.data) {
        setSettings({ ...DEFAULT_SETTINGS, ...res.data });
        savedImageIdRef.current = res.data.upi_qr_image_id || '';
      }
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setSettings(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
    setFieldErrors(prev => ({ ...prev, [name]: undefined }));
  };

  const uploadImageFile = async (file) => {
    const sizeError = getImageUploadError(file);
    if (sizeError) {
      setUploadMessage({ type: 'error', text: sizeError });
      return;
    }

    const data = new FormData();
    data.append('image', file);
    const previousPendingId = settings.upi_qr_image_id;

    try {
      setUploadingImage(true);
      setUploadMessage(null);
      const res = await ImagesApi.upload(data);
      const image = getUploadedImage(res);
      setSettings(prev => ({
        ...prev,
        upi_qr_image_id: image.id,
        upi_qr_image_url: image.url,
      }));
      // Discard the previous unsaved upload from this session so re-picking a
      // photo before hitting Save doesn't leak an orphaned S3 object.
      if (previousPendingId && previousPendingId !== savedImageIdRef.current) {
        ImagesApi.delete(previousPendingId).catch(() => {});
      }
      setUploadMessage({ type: 'success', text: 'QR image uploaded. Save settings to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'qr',
    defaultAspect: 1,
    onCropped: uploadImageFile,
  });

  const focusFirstInvalid = () => {
    setTimeout(() => {
      const el = document.querySelector('[aria-invalid="true"]');
      el?.focus();
    }, 0);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setFormError(null);
      setFieldErrors({});
      const nullableNumber = (value) => (value === '' || value === null || value === undefined ? null : Number(value));
      const nonNegativeFields = [
        ['delivery_charge', 'Delivery charge'],
        ['night_charge', 'Night delivery surcharge'],
        ['rain_charge', 'Rain charge'],
        ['fast_delivery_charge', 'Fast delivery surcharge'],
      ];

      for (const [field, label] of nonNegativeFields) {
        // Skip fields that aren't active — a stale negative value hidden in
        // the DB must not block save (the input isn't even rendered).
        if (field === 'fast_delivery_charge' && !settings.fast_delivery_enabled) continue;
        if (field === 'rain_charge' && !settings.rain_charge_enabled) continue;
        const value = settings[field];
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric < 0) {
          const msg = `${label} must be a valid non-negative number.`;
          setFieldErrors({ [field]: msg });
          setFormError(msg);
          setSaving(false);
          focusFirstInvalid();
          return;
        }
      }

      // Night charge requires both start and end times when active.
      // Otherwise customers are either always or never charged at night.
      if (Number(settings.night_charge) > 0) {
        if (!settings.night_charge_start || !settings.night_charge_end) {
          const msg = 'Night charge is set but the start or end time is missing. Either set both times or set the charge to 0.';
          setFieldErrors({ night_charge_start: msg, night_charge_end: msg });
          setFormError(msg);
          setSaving(false);
          focusFirstInvalid();
          return;
        }
      }

      // Ensure numeric fields are numbers
      // Validate minimum_version format if provided
      const minVer = (settings.minimum_version || '').trim();
      if (minVer && !/^\d+\.\d+\.\d+$/.test(minVer)) {
        const msg = 'Minimum version must be in semver format: e.g. 1.2.0';
        setFieldErrors({ minimum_version: msg });
        setFormError(msg);
        setSaving(false);
        focusFirstInvalid();
        return;
      }
      const curVer = (settings.current_version || '').trim();
      if (curVer && !/^\d+\.\d+\.\d+$/.test(curVer)) {
        const msg = 'Current version must be in semver format: e.g. 1.1.1';
        setFieldErrors({ current_version: msg });
        setFormError(msg);
        setSaving(false);
        focusFirstInvalid();
        return;
      }

      const payload = {
        ...settings,
        delivery_charge: Number(settings.delivery_charge),
        night_charge: Number(settings.night_charge),
        rain_charge_enabled: Boolean(settings.rain_charge_enabled),
        rain_charge: Number(settings.rain_charge || 0),
        fast_delivery_enabled: Boolean(settings.fast_delivery_enabled),
        fast_delivery_charge: Number(settings.fast_delivery_charge || 0),
        standard_delivery_minutes: Number.parseInt(settings.standard_delivery_minutes, 10) || 60,
        fast_delivery_minutes: Number.parseInt(settings.fast_delivery_minutes, 10) || 30,
        upi_qr_image_id: settings.upi_qr_image_id || null,
        minimum_version: minVer || null,
        current_version: curVer || null,
      };
      const response = await SettingsApi.update(payload);
      if (response.data) {
        // Merge over the current state — NOT over DEFAULT_SETTINGS — so that
        // fields the backend doesn't echo back (e.g. whatsapp_number) keep the
        // value the admin just typed instead of reverting to blank.
        setSettings(prev => ({ ...prev, ...response.data }));
      }
      savedImageIdRef.current = settings.upi_qr_image_id || '';
      setSaveSuccess('Settings saved successfully!');
    } catch (err) {
      console.error(err);
      setFormError(GENERIC_ERROR);
    } finally {
      setSaving(false);
    }
  };

  if (isAllAreas) {
    return <div className="settings-container"><PickAreaNotice label="Settings" /></div>;
  }

  if (loading) {
    return <div className="settings-container"><p style={{ textAlign: 'center', padding: '2rem' }}>Loading configuration...</p></div>;
  }

  return (
    <div className="settings-container">
      <header className="settings-header">
        <h1 className="settings-title">Shop Settings</h1>
        <button className="btn-primary" onClick={handleSave} disabled={saving || uploadingImage}>
          {saving ? 'Saving...' : 'Save All Changes'}
        </button>
      </header>

      <MessageBanner type="error" message={formError} onDismiss={() => setFormError(null)} />
      <MessageBanner type="success" message={saveSuccess} onDismiss={() => setSaveSuccess(null)} />

      {error && <div className="error-container" style={{ marginBottom: '1rem' }}>{error}</div>}

      {settings.delivery_available === false && (
        <div style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)', padding: '1rem', borderRadius: '4px', marginBottom: '1rem', border: '1px solid var(--warning-border)' }}>
          <strong>Warning:</strong> Delivery is currently OFF. Customers will not be able to select delivery at checkout.
        </div>
      )}

      {/* ── 1. Operational Status ────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Operational Status</h2>
        <div className="settings-form-grid">
          <div className="toggle-switch-wrapper">
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>Shop Open</strong>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Allow customers to place orders on the app.</span>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" name="shop_open" checked={settings.shop_open} onChange={handleChange} />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="toggle-switch-wrapper">
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>Delivery Available</strong>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Auto-managed by rider online status (ON when any rider is online, OFF when none). Manual toggle still works as an override until the next rider event.
              </span>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" name="delivery_available" checked={settings.delivery_available} onChange={handleChange} />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </div>
      </section>

      {/* ── 2. Delivery Pricing ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Delivery Pricing</h2>
        <div className="settings-form-grid">
          <div className="settings-form-group">
            <label className="settings-label">Delivery Charge (₹)</label>
            <input
              type="number"
              min="0"
              step="1"
              name="delivery_charge"
              className="settings-input"
              value={settings.delivery_charge}
              onChange={handleChange}
              aria-invalid={Boolean(fieldErrors.delivery_charge)}
              aria-errormessage={fieldErrors.delivery_charge ? 'delivery_charge-error' : undefined}
            />
            {fieldErrors.delivery_charge && (
              <span id="delivery_charge-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                {fieldErrors.delivery_charge}
              </span>
            )}
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Flat delivery fee for all orders. Free-delivery promotions (e.g. above a minimum order) are configured via Coupons → Free Delivery.
            </span>
          </div>
        </div>
      </section>

      {/* ── 4. Delivery Speed ───────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Delivery Speed</h2>
        <div className="settings-form-grid">
          <div className="settings-form-group">
            <label className="settings-label">🕐 Standard Delivery Time (minutes)</label>
            <input
              type="number"
              min="1"
              max="1439"
              step="1"
              name="standard_delivery_minutes"
              className="settings-input"
              value={settings.standard_delivery_minutes ?? 60}
              onChange={handleChange}
              placeholder="e.g. 60"
              aria-invalid={Boolean(fieldErrors.standard_delivery_minutes)}
              aria-errormessage={fieldErrors.standard_delivery_minutes ? 'standard_delivery_minutes-error' : undefined}
            />
            {fieldErrors.standard_delivery_minutes && (
              <span id="standard_delivery_minutes-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                {fieldErrors.standard_delivery_minutes}
              </span>
            )}
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Shown to the customer as the ETA for standard delivery. 1–1439 minutes.
            </span>
          </div>

          <div className="toggle-switch-wrapper full-width fast-delivery-toggle">
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>
                ⚡ Fast Delivery Option
              </strong>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                When enabled, customers can choose fast delivery at a fixed charge and ETA you set below.
                Replaces the standard delivery charge for eligible orders.
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                name="fast_delivery_enabled"
                checked={Boolean(settings.fast_delivery_enabled)}
                onChange={handleChange}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {Boolean(settings.fast_delivery_enabled) && (
            <>
              <div className="settings-form-group fast-delivery-charge-input">
                <label className="settings-label">⚡ Fast Delivery Charge (₹)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  name="fast_delivery_charge"
                  className="settings-input"
                  value={settings.fast_delivery_charge ?? 0}
                  onChange={handleChange}
                  placeholder="e.g. 50"
                  aria-invalid={Boolean(fieldErrors.fast_delivery_charge)}
                  aria-errormessage={fieldErrors.fast_delivery_charge ? 'fast_delivery_charge-error' : undefined}
                />
                {fieldErrors.fast_delivery_charge && (
                  <span id="fast_delivery_charge-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                    {fieldErrors.fast_delivery_charge}
                  </span>
                )}
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Added on top of the standard delivery charge when the customer opts into fast delivery.
                </span>
              </div>
              <div className="settings-form-group">
                <label className="settings-label">⚡ Fast Delivery Time (minutes)</label>
                <input
                  type="number"
                  min="1"
                  max="1439"
                  step="1"
                  name="fast_delivery_minutes"
                  className="settings-input"
                  value={settings.fast_delivery_minutes ?? 30}
                  onChange={handleChange}
                  placeholder="e.g. 30"
                  aria-invalid={Boolean(fieldErrors.fast_delivery_minutes)}
                  aria-errormessage={fieldErrors.fast_delivery_minutes ? 'fast_delivery_minutes-error' : undefined}
                />
                {fieldErrors.fast_delivery_minutes && (
                  <span id="fast_delivery_minutes-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                    {fieldErrors.fast_delivery_minutes}
                  </span>
                )}
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  Shown to the customer as the ETA for fast delivery. 1–1439 minutes.
                </span>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── 5. Night Delivery ───────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Night Delivery</h2>
        <div className="settings-form-grid">
          <div className="settings-form-group">
            <label className="settings-label">Night Delivery Surcharge (₹)</label>
            <input
              type="number"
              min="0"
              step="1"
              name="night_charge"
              className="settings-input"
              value={settings.night_charge}
              onChange={handleChange}
              aria-invalid={Boolean(fieldErrors.night_charge)}
              aria-errormessage={fieldErrors.night_charge ? 'night_charge-error' : undefined}
            />
            {fieldErrors.night_charge && (
              <span id="night_charge-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                {fieldErrors.night_charge}
              </span>
            )}
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Extra amount added to every order placed inside the night window. Set to 0 to disable.
            </span>
          </div>
          <div className="settings-form-group">
            <label className="settings-label">Night Window — Start Time</label>
            <input
              type="time"
              name="night_charge_start"
              className="settings-input"
              value={settings.night_charge_start || ''}
              onChange={handleChange}
              aria-invalid={Boolean(fieldErrors.night_charge_start)}
              aria-errormessage={fieldErrors.night_charge_start ? 'night_charge_start-error' : undefined}
            />
            {fieldErrors.night_charge_start && (
              <span id="night_charge_start-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                {fieldErrors.night_charge_start}
              </span>
            )}
          </div>
          <div className="settings-form-group">
            <label className="settings-label">Night Window — End Time</label>
            <input
              type="time"
              name="night_charge_end"
              className="settings-input"
              value={settings.night_charge_end || ''}
              onChange={handleChange}
              aria-invalid={Boolean(fieldErrors.night_charge_end)}
              aria-errormessage={fieldErrors.night_charge_end ? 'night_charge_end-error' : undefined}
            />
            {fieldErrors.night_charge_end && (
              <span id="night_charge_end-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                {fieldErrors.night_charge_end}
              </span>
            )}
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              End before start means the window crosses midnight (e.g. 21:00 → 07:00).
            </span>
          </div>
        </div>
      </section>

      {/* ── 5b. Rain Charge ─────────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Rain Charge</h2>
        <div className="settings-form-grid">
          <div className="toggle-switch-wrapper full-width">
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--text-primary)' }}>
                🌧️ Rain Charge
              </strong>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                When enabled, a fixed surcharge is added to every order's bill. Turn this on/off
                manually during rain — unlike Night Delivery, there's no time window.
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                name="rain_charge_enabled"
                checked={Boolean(settings.rain_charge_enabled)}
                onChange={handleChange}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {Boolean(settings.rain_charge_enabled) && (
            <div className="settings-form-group">
              <label className="settings-label">🌧️ Rain Charge (₹)</label>
              <input
                type="number"
                min="0"
                step="1"
                name="rain_charge"
                className="settings-input"
                value={settings.rain_charge ?? 0}
                onChange={handleChange}
                placeholder="e.g. 15"
                aria-invalid={Boolean(fieldErrors.rain_charge)}
                aria-errormessage={fieldErrors.rain_charge ? 'rain_charge-error' : undefined}
              />
              {fieldErrors.rain_charge && (
                <span id="rain_charge-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                  {fieldErrors.rain_charge}
                </span>
              )}
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Extra amount added to every order while rain charge is on.
              </span>
            </div>
          )}
        </div>
      </section>

      {/* ── 6. Contact & Payment Info ───────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">Contact & Payment Info</h2>
        <div className="settings-form-grid">
          <div className="settings-form-group">
            <label className="settings-label">WhatsApp Number</label>
            <input type="text" name="whatsapp_number" className="settings-input" placeholder="+91..." value={settings.whatsapp_number || ''} onChange={handleChange} />
          </div>
          <div className="settings-form-group">
            <label className="settings-label">Support Phone Number</label>
            <input type="text" name="support_phone" className="settings-input" value={settings.support_phone || ''} onChange={handleChange} />
          </div>

          <div className="settings-form-group full-width">
            <label className="settings-label">UPI ID (For manual payments)</label>
            <input type="text" name="upi_id" className="settings-input" value={settings.upi_id || ''} onChange={handleChange} />
          </div>

          <div className="settings-form-group full-width">
            <label className="settings-label">UPI QR Code Image</label>
            <p className="image-dimension-hint">{IMAGE_GUIDANCE.qr.label}</p>
            {settings.upi_qr_image_url && <img src={normalizeImageUrl(settings.upi_qr_image_url)} alt="UPI QR" className="qr-preview" />}
            <div
              style={{ border: '2px dashed var(--border-color)', padding: '2rem', textAlign: 'center', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: 'var(--bg-color)' }}
              onClick={() => fileInputRef.current?.click()}
            >
              <input type="file" hidden ref={fileInputRef} {...fileInputProps} accept="image/*" />
              {uploadingImage ? 'Uploading...' : 'Click to Upload new QR Code'}
            </div>
            {uploadMessage && (
              <p className={`upload-message ${uploadMessage.type}`}>{uploadMessage.text}</p>
            )}
          </div>
        </div>
      </section>

      {/* ── 7. App Version Control ──────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="settings-section-title">📱 App Version Control</h2>
        <div className="settings-form-grid">
          {/* Editable: current published version (stored in DB, not hardcoded) */}
          <div className="settings-form-group">
            <label className="settings-label">Current App Version (Play Store)</label>
            <input
              type="text"
              name="current_version"
              className="settings-input"
              placeholder="e.g. 1.1.1"
              value={settings.current_version || ''}
              onChange={handleChange}
              aria-invalid={Boolean(fieldErrors.current_version)}
              aria-errormessage={fieldErrors.current_version ? 'current_version-error' : undefined}
            />
            {fieldErrors.current_version && (
              <span id="current_version-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                {fieldErrors.current_version}
              </span>
            )}
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              The version currently live on the Play Store. Update this after each release so you know what to set the minimum version to.
            </span>
          </div>

          {/* Control: minimum_version input */}
          <div className="settings-form-group">
            <label className="settings-label">Minimum Required Version</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                name="minimum_version"
                className="settings-input"
                style={{ flex: 1 }}
                placeholder="e.g. 1.1.0  (leave blank to disable)"
                value={settings.minimum_version || ''}
                onChange={handleChange}
                aria-invalid={Boolean(fieldErrors.minimum_version)}
                aria-errormessage={fieldErrors.minimum_version ? 'minimum_version-error' : undefined}
              />
              {fieldErrors.minimum_version && (
                <span id="minimum_version-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                  {fieldErrors.minimum_version}
                </span>
              )}
              {settings.minimum_version && (
                <button
                  type="button"
                  style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-color)',
                    background: 'var(--overlay-dark)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={() => setSettings(prev => ({ ...prev, minimum_version: '' }))}
                >
                  Clear
                </button>
              )}
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Users with an older version will see a <strong>blocking update prompt</strong> and cannot use the app until they update from the Play Store. Leave blank to disable.
            </span>
          </div>

          {/* Live status badge */}
          <div className="settings-form-group full-width">
            <div style={{
              padding: '0.85rem 1rem',
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${settings.minimum_version ? 'var(--warning-border, #f59e0b)' : 'var(--border-color)'}`,
              background: settings.minimum_version ? 'var(--warning-bg, #fffbeb)' : 'var(--overlay-dark)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              fontSize: '0.88rem',
              color: settings.minimum_version ? 'var(--warning-text, #92400e)' : 'var(--text-secondary)',
            }}>
              <span style={{ fontSize: '1rem' }}>{settings.minimum_version ? '⚠️' : '✅'}</span>
              {settings.minimum_version
                ? `Force update is ACTIVE — users on versions older than ${settings.minimum_version} will be blocked.`
                : 'Force update is OFF — all app versions are allowed.'}
            </div>
          </div>
        </div>
      </section>

      <div className="settings-footer">
        <button className="btn-primary" style={{ padding: '1rem 3rem', fontSize: '1.1rem' }} onClick={handleSave} disabled={saving || uploadingImage}>
          {saving ? 'Saving...' : 'Save All Changes'}
        </button>
      </div>
      <ImageCropper {...cropperProps} />
    </div>
  );
}
