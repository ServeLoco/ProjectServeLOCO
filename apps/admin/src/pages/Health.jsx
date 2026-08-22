import React, { useState, useEffect } from 'react';
import { HealthApi } from '../api';
import './Health.css';

export default function Health() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastCheck, setLastCheck] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    checkHealth();
  }, []);

  const checkHealth = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await HealthApi.check();
      setHealth(res);
      setLastCheck(new Date());
    } catch (err) {
      // If the API is completely down, it might throw a network error or 503
      setHealth(err.response?.data || { status: 'error', databases: { mysql: 'error', mongodb: 'error' } });
      setError('Backend API is unreachable or returned an error.');
      setLastCheck(new Date());
    } finally {
      setLoading(false);
    }
  };

  const isHealthy = health?.status === 'ok';
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

  return (
    <div className="health-container">
      <header className="health-header">
        <h1 className="health-title">System Health</h1>
        <button className="btn-secondary" onClick={checkHealth} disabled={loading}>
          {loading ? 'Checking...' : 'Refresh Status'}
        </button>
      </header>

      <div className="health-card">
        <div className="health-overall">
          <div className={`health-status-icon ${loading ? 'loading' : isHealthy ? 'ok' : 'error'}`}>
            {loading ? '...' : isHealthy ? '✓' : '!'}
          </div>
          <div className="health-overall-text">
            <h2>{loading ? 'Checking Systems...' : isHealthy ? 'All Systems Operational' : 'System Degraded'}</h2>
            <p>Last checked: {lastCheck ? lastCheck.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Never'}</p>
          </div>
        </div>

        <div className="service-grid">
          <div className="service-item">
            <div className="service-info">
              <span className="service-name">Core API Server</span>
              <span className="service-time">{apiBaseUrl}</span>
            </div>
            <span className={`service-badge ${health ? 'ok' : 'error'}`}>
              {health ? 'OK' : 'OFFLINE'}
            </span>
          </div>

          <div className="service-item">
            <div className="service-info">
              <span className="service-name">MySQL Database</span>
              <span className="service-time">Primary Relational Store</span>
            </div>
            <span className={`service-badge ${health?.databases?.mysql === 'ok' ? 'ok' : 'error'}`}>
              {health?.databases?.mysql === 'ok' ? 'OK' : 'ERROR'}
            </span>
          </div>

          <div className="service-item">
            <div className="service-info">
              <span className="service-name">MongoDB Database</span>
              <span className="service-time">Audit & Logs Store</span>
            </div>
            <span className={`service-badge ${health?.databases?.mongodb === 'ok' ? 'ok' : 'error'}`}>
              {health?.databases?.mongodb === 'ok' ? 'OK' : 'ERROR'}
            </span>
          </div>
        </div>

        {!isHealthy && !loading && health && (
          <div className="health-troubleshoot">
            <h4>Troubleshooting</h4>
            <p>
              One or more services are currently unreachable. 
              {health.databases?.mysql !== 'ok' && ' Ensure the MySQL service is running and credentials are correct in the backend .env file. '}
              {health.databases?.mongodb !== 'ok' && ' Ensure the MongoDB service is running and the connection string is valid. '}
              {!health.databases && ' The core Node.js backend server might be completely offline. Restart the server.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
