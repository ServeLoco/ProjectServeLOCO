import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ImagesApi } from '../api';
import { normalizeImageUrl } from '../utils/imageUrl';
import { IMAGE_GUIDANCE } from '../utils/imageGuidance';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import './Images.css';

import { GENERIC_ERROR } from '../utils/constants';

export default function Images() {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [uploadMessage, setUploadMessage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showUnusedOnly, setShowUnusedOnly] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetchImages();
  }, []);

  const fetchImages = async () => {
    try {
      setLoading(true);
      const res = await ImagesApi.list();
      setImages(res.data || []);
    } catch (err) {
      console.error(err);
      setError(err?.response?.data?.message || err?.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const uploadImageFile = async (file) => {
    const sizeError = getImageUploadError(file);
    if (sizeError) {
      setUploadMessage({ type: 'error', text: sizeError });
      return;
    }

    const data = new FormData();
    data.append('image', file);

    try {
      setUploading(true);
      setUploadMessage(null);
      await ImagesApi.upload(data);
      setUploadMessage({ type: 'success', text: 'Image uploaded successfully.' });
      fetchImages();
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: err?.response?.data?.message || err?.message || GENERIC_ERROR });
    } finally {
      setUploading(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'library',
    defaultAspect: 1,
    onCropped: uploadImageFile,
  });

  const handleCopyUrl = (url) => {
    navigator.clipboard.writeText(normalizeImageUrl(url));
    setUploadMessage({ type: 'success', text: 'URL copied to clipboard.' });
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatImageDate = (img) => {
    const value = img.created_at || img.createdAt;
    if (!value) return 'Unknown date';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  };

  // Client-side filter: filename + original name + altText + url match the query.
  const filteredImages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return images.filter((img) => {
      if (showUnusedOnly && img.in_use) return false;
      if (!q) return true;
      const haystack = [
        img.filename,
        img.originalName,
        img.altText,
        img.url,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [images, searchQuery, showUnusedOnly]);

  const handleBulkDeleteUnused = async () => {
    const targets = filteredImages.filter((img) => !img.in_use);
    if (targets.length === 0) return;

    const label = targets.length === 1 ? '1 unused image' : `${targets.length} unused images`;
    if (!window.confirm(`Delete ${label} permanently? This cannot be undone.`)) return;

    setBulkDeleting(true);
    setError(null);
    const deletedIds = [];
    let failCount = 0;

    for (const img of targets) {
      try {
        await ImagesApi.delete(img.id);
        deletedIds.push(img.id);
      } catch (err) {
        console.error(err);
        failCount += 1;
      }
    }

    if (deletedIds.length > 0) {
      setImages((prev) => prev.filter((img) => !deletedIds.includes(img.id)));
    }

    if (failCount > 0) {
      setError(`Failed to delete ${failCount} image${failCount === 1 ? '' : 's'}.`);
    } else if (deletedIds.length > 0) {
      setUploadMessage({
        type: 'success',
        text: `Deleted ${deletedIds.length} unused image${deletedIds.length === 1 ? '' : 's'}.`,
      });
    }

    setBulkDeleting(false);
  };

  return (
    <div className="images-container">
      <header className="images-header">
        <h1 className="images-title">Image Library</h1>
      </header>

      <div className="image-upload-area" onClick={() => fileInputRef.current?.click()}>
        <input type="file" hidden ref={fileInputRef} {...fileInputProps} accept="image/*" />
        <h3 style={{ color: 'var(--primary-color)', marginBottom: '0.5rem' }}>{uploading ? 'Uploading...' : 'Click to Upload New Image'}</h3>
        <p style={{ color: 'var(--text-secondary)' }}>Supported formats: JPG, PNG, WebP. Max size: 5MB.</p>
        <p className="image-dimension-hint">{IMAGE_GUIDANCE.library.label}</p>
      </div>
      {uploadMessage && (
        <p className={`upload-message ${uploadMessage.type}`} style={{ marginBottom: '1rem' }}>{uploadMessage.text}</p>
      )}

      {error && <div className="error-container" style={{ marginBottom: '2rem' }}>{error}</div>}

      {/* Search + filter bar */}
      {!loading || images.length > 0 ? (
        <div className="filter-bar images-filter-bar">
          <input
            type="text"
            className="filter-input filter-search images-filter-search"
            placeholder="Search by filename, original name, alt text, or URL…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <label className="images-filter-checkbox">
            <input
              type="checkbox"
              checked={showUnusedOnly}
              onChange={(e) => setShowUnusedOnly(e.target.checked)}
            />
            Show unused only
          </label>
          <span className="images-filter-count">
            {filteredImages.length} / {images.length}
          </span>
        </div>
      ) : null}

      {showUnusedOnly && filteredImages.length > 0 && (
        <div className="bulk-actions-bar images-bulk-actions-bar">
          <span className="bulk-actions-info">
            {filteredImages.length} unused image{filteredImages.length === 1 ? '' : 's'} shown
          </span>
          <div className="bulk-actions-buttons">
            <button
              type="button"
              className="btn-danger"
              onClick={handleBulkDeleteUnused}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? 'Deleting…' : `Delete all (${filteredImages.length})`}
            </button>
          </div>
        </div>
      )}

      {loading && images.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>Loading image library...</div>
      ) : images.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', background: 'var(--surface-color)', borderRadius: 'var(--radius-lg)' }}>
          No images uploaded yet.
        </div>
      ) : filteredImages.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', background: 'var(--surface-color)', borderRadius: 'var(--radius-lg)' }}>
          No images match your filters.
        </div>
      ) : (
        <div className="images-grid">
          {filteredImages.map(img => (
            <div key={img.id} className="image-card">
              <div className={`image-usage-badge ${img.in_use ? 'used' : 'unused'}`}>
                {img.in_use ? 'IN USE' : 'UNUSED'}
              </div>
              <div className="image-preview-wrapper">
                <img src={normalizeImageUrl(img.url)} alt={img.filename} loading="lazy" />
              </div>
              <div className="image-details">
                <div className="image-filename" title={img.filename}>{img.filename}</div>
                <div className="image-meta">
                  <span>{formatSize(img.size)}</span>
                  <span>{formatImageDate(img)}</span>
                </div>
              </div>
              <div className="image-actions">
                <button type="button" className="btn-icon" onClick={() => handleCopyUrl(img.url)}>
                  Copy URL
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ImageCropper {...cropperProps} />
    </div>
  );
}
