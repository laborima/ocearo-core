/**
 * src/dataprovider/signalk.js
 *
 * Signal K data provider
 * Handles subscriptions and data fetching from Signal K paths
 */

const { skPaths, conversions } = require('../common');

class SignalKDataProvider {
  /**
   * @param {object} app  Signal K plugin `app` object
   * @param {string} pluginId  plugin id used when writing back to the server
   */
  constructor(app, pluginId) {
    this.app = app;
    this.pluginId = pluginId || 'ocearo-plugin';

    // list of unsubscribe functions (call on stop)
    this.unsubscribes = [];

    // track notification keys we have seen
    this.lastNotificationKeys = new Set();

    // bound handlers so unsubscribe works reliably
    this._boundHandleDelta = this._handleDelta.bind(this);
    this._boundHandleNotificationDelta = this._handleNotificationDelta.bind(this);
  }

  /**
   * Start the provider. This is async because some subscription managers return promises.
   */
  async start() {
    this._debug('Starting Signal K data provider');

    const manager = this._findSubscriptionManager();
    if (!manager) {
      // run in limited mode (read-only via getSelfPath) — don't throw, but log strongly
      this._debug('No subscription manager found on app; running in limited mode (no live subscriptions)');
      return;
    }

    try {
      await this.subscribeToVesselData(manager);
      this._debug('Subscribed to vessel data');

      await this.subscribeToNotifications(manager);
      this._debug('Subscribed to notifications');
    } catch (err) {
      // make sure start errors bubble with useful information
      this._error('Failed to start SignalKDataProvider:', err && err.message ? err.message : err);
      throw err;
    }
  }

  /**
   * Stop provider and cleanup all subscriptions
   */
  async stop() {
    this._debug('Stopping Signal K data provider');

    // If subscriptionmanager provided unsubscribe functions via this.unsubscribes array,
    // they are functions we should call to unsubscribe.
    try {
      // call stored unsubscribe functions (they may be sync or async)
      for (const fn of this.unsubscribes.slice()) {
        try {
          const maybe = fn();
          if (maybe && typeof maybe.then === 'function') {
            await maybe;
          }
        } catch (e) {
          this._error('Error during unsubscribe function:', e);
        }
      }
    } catch (e) {
      this._error('Error while running unsubscribes:', e);
    }

    // reset state
    this.unsubscribes = [];
    this.lastNotificationKeys.clear();
  }

  /**
   * Subscribe to vessel data paths (uses manager.subscribe API).
   * @param {object} manager - subscription manager (could be app.subscriptionmanager or app.signalk.subscriptionmanager)
   */
  async subscribeToVesselData(manager) {
    if (!manager) {
      this._debug('No subscription manager available for vessel data');
      return;
    }

    const paths = [
      skPaths.navigation.position,
      skPaths.navigation.courseOverGroundTrue,
      skPaths.navigation.courseOverGroundMagnetic,
      skPaths.navigation.speedOverGround,
      skPaths.navigation.headingTrue,
      skPaths.navigation.headingMagnetic,
      skPaths.environment.depthBelowKeel,
      skPaths.environment.depthBelowTransducer,
      skPaths.environment.wind.speedTrue,
      skPaths.environment.wind.angleTrueWater,
      skPaths.environment.wind.speedApparent,
      skPaths.environment.wind.angleApparent,
      skPaths.environment.water.temperature,
      'electrical.batteries.*',
      'propulsion.*'
    ];

    const subscription = {
      context: 'vessels.self',
      subscribe: paths.map(path => ({ path, period: 1000 }))
    };

    // Many Signal K subscriptionmanager APIs accept (subscription, unsubscribesArray, errCb, deltaCb)
    // but implementations vary. We handle both callback-style and promise returns.
    try {
      const maybe = manager.subscribe(
        subscription,
        this.unsubscribes,
        err => {
          if (err) this._error('Signal K vessel subscription error:', err);
          else this._debug('Successfully subscribed to vessel data (callback-style)');
        },
        delta => this._boundHandleDelta(delta)
      );

      // Some managers return a Promise or subscription object; if it's a Promise, await it.
      if (maybe && typeof maybe.then === 'function') {
        await maybe;
        this._debug('Successfully subscribed to vessel data (promise-style)');
      }

      // If manager.subscribe returned a single unsubscribe function (instead of populating the array),
      // normalize that into our unsubscribes array.
      if (typeof maybe === 'function') {
        this.unsubscribes.push(maybe);
      }
    } catch (err) {
      this._error('Failed to create vessel data subscription:', err);
      // don't rethrow here; higher-level start() will decide what to do.
      throw err;
    }
  }

  /**
   * Subscribe to notifications
   * @param {object} manager
   */
  async subscribeToNotifications(manager) {
    if (!manager) {
      this._debug('No subscription manager available for notifications');
      return;
    }

    const subscription = {
      context: 'vessels.self',
      subscribe: [{ path: 'notifications.*', period: 500 }]
    };

    try {
      const maybe = manager.subscribe(
        subscription,
        this.unsubscribes,
        err => {
          if (err) this._error('Notifications subscription error:', err);
          else this._debug('Successfully subscribed to notifications (callback-style)');
        },
        delta => this._boundHandleNotificationDelta(delta)
      );

      if (maybe && typeof maybe.then === 'function') {
        await maybe;
        this._debug('Successfully subscribed to notifications (promise-style)');
      }

      if (typeof maybe === 'function') {
        this.unsubscribes.push(maybe);
      }
    } catch (err) {
      this._error('Failed to create notifications subscription:', err);
      throw err;
    }
  }

  /**
   * Internal delta handler wrapper (keeps original name for clarity)
   * @private
   */
  _handleDelta(delta) {
    try {
      this.handleDelta(delta);
    } catch (err) {
      // protect the subscription loop from crashing the process
      this._error('Unhandled error in _handleDelta:', err);
    }
  }

  /**
   * Internal notification delta handler wrapper
   * @private
   */
  _handleNotificationDelta(delta) {
    try {
      this.handleNotificationDelta(delta);
    } catch (err) {
      this._error('Unhandled error in _handleNotificationDelta:', err);
    }
  }

  /**
   * Public handler for vessel data delta objects
   * @param {object} delta
   */
  handleDelta(delta) {
    if (!delta || !Array.isArray(delta.updates)) {
     return;
    }

    try {
   
      delta.updates.forEach((update, updateIndex) => {
        if (!update || !Array.isArray(update.values)) {
          return;
        }

        update.values.forEach((pathValue, valueIndex) => {
          try {
        
            // Use safe handleMessage wrapper (some servers expect messages in a specific envelope)
            this._safeHandleMessage({
              context: delta.context || 'vessels.self',
              updates: [
                {
                  timestamp: update.timestamp || new Date().toISOString(),
                  values: [pathValue]
                }
              ]
            });
          } catch (valueError) {
            this._error(`Error processing value ${valueIndex} in update ${updateIndex}:`, valueError && valueError.message ? valueError.message : valueError);
            this._error('PathValue:', JSON.stringify(pathValue));
          }
        });
      });
    } catch (error) {
      this._error('Error handling vessel data delta:', error && error.message ? error.message : error);
      this._error('Delta object:', JSON.stringify(delta, null, 2));
      if (error && error.stack) {
        this._error('Stack trace:', error.stack);
      }
    }
  }

  /**
   * Public handler for notifications delta objects
   * @param {object} delta
   */
  handleNotificationDelta(delta) {
    if (!delta || !Array.isArray(delta.updates)) return;

    try {
      delta.updates.forEach(update => {
        if (!update || !Array.isArray(update.values)) return;

        update.values.forEach(pathValue => {
          const path = pathValue && pathValue.path;
          const value = pathValue && pathValue.value;

          if (!path) return;

          // Ignore notifications created by our plugin
          if (path.startsWith(`notifications.${this.pluginId}`) || path.startsWith('notifications.ocearo.')) {
            return;
          }

          if (value === null) {
            // notification cleared
            this.lastNotificationKeys.delete(path);
            this._emitSafe('notification.cleared', { path });
          } else if (value && value.state) {
            // raised or updated
            const isNew = !this.lastNotificationKeys.has(path);
            this._emitSafe('notification.raised', { path, notification: value, isNew });
            this.lastNotificationKeys.add(path);
          }
        });
      });
    } catch (error) {
      this._error('Error handling notification delta:', error);
    }
  }

  /**
   * Return current active notifications tracked
   * @returns {Array<{path, state, message, timestamp, severity, method}>}
   */
  getNotifications() {
    const notifications = [];

    try {
      this.lastNotificationKeys.forEach(path => {
        const value = this._getSelfPath(path);

        if (value && value.state && !path.startsWith(`notifications.${this.pluginId}`) && !path.startsWith('notifications.ocearo.')) {
          notifications.push({
            path,
            state: value.state,
            message: value.message || '',
            timestamp: value.timestamp || new Date().toISOString(),
            severity: value.state,
            method: value.method || []
          });
        }
      });
    } catch (err) {
      this._error('Error getting notifications:', err);
    }

    return notifications;
  }

  /**
   * Read commonly used vessel fields from server
   */
  getVesselData() {
    try {
      return {
        navigation: {
          speedOverGround: this._getSelfPath(skPaths.navigation.speedOverGround),
          courseOverGroundTrue: this._getSelfPath(skPaths.navigation.courseOverGroundTrue),
          courseOverGroundMagnetic: this._getSelfPath(skPaths.navigation.courseOverGroundMagnetic),
          headingTrue: this._getSelfPath(skPaths.navigation.headingTrue),
          headingMagnetic: this._getSelfPath(skPaths.navigation.headingMagnetic),
          position: this._getSelfPath(skPaths.navigation.position)
        },
        environment: {
          depth: {
            belowKeel: this._getSelfPath(skPaths.environment.depthBelowKeel),
            belowTransducer: this._getSelfPath(skPaths.environment.depthBelowTransducer)
          },
          wind: {
            speedApparent: this._getSelfPath(skPaths.environment.wind.speedApparent),
            angleApparent: this._getSelfPath(skPaths.environment.wind.angleApparent),
            speedTrue: this._getSelfPath(skPaths.environment.wind.speedTrue),
            angleTrueWater: this._getSelfPath(skPaths.environment.wind.angleTrueWater)
          },
          water: {
            temperature: this._getSelfPath(skPaths.environment.water.temperature)
          }
        },
        electrical: {
          batteries: this._getSelfPath('electrical.batteries') || {}
        },
        propulsion: this._getSelfPath('propulsion') || {}
      };
    } catch (error) {
      this._error('Error getting vessel data:', error);
      return {};
    }
  }

  /**
   * Check critical values against thresholds object
   * thresholds = { minDepth, maxWind, lowBattery, highTemperature }
   * Returns array of alerts
   */
  checkCriticalValues(thresholds = {}) {
    const alerts = [];

    try {
      const data = this.getVesselData();

      // Depth check
      if (thresholds.minDepth != null) {
        const depth = data.environment?.depth?.belowKeel;
        if (typeof depth === 'number' && depth < thresholds.minDepth) {
          alerts.push({
            type: 'critical-depth',
            value: depth,
            threshold: thresholds.minDepth,
            message: `Critical depth: ${depth.toFixed(1)}m (min: ${thresholds.minDepth}m)`
          });
        }
      }

      // Wind check (convert m/s to knots)
      if (thresholds.maxWind != null) {
        const windSpeed = data.environment?.wind?.speedApparent;
        if (typeof windSpeed === 'number') {
          const windKnots = conversions && conversions.msToKnots ? conversions.msToKnots(windSpeed) : windSpeed;
          if (windKnots > thresholds.maxWind) {
            alerts.push({
              type: 'high-wind',
              value: windKnots,
              threshold: thresholds.maxWind,
              message: `High wind: ${windKnots.toFixed(1)}kt (max: ${thresholds.maxWind}kt)`
            });
          }
        }
      }

      // Battery check
      if (thresholds.lowBattery != null && data.electrical?.batteries) {
        Object.entries(data.electrical.batteries).forEach(([id, battery]) => {
          const socRaw = battery?.capacity?.stateOfCharge;
          if (typeof socRaw === 'number') {
            const soc = socRaw * 100;
            if (soc < thresholds.lowBattery) {
              alerts.push({
                type: 'low-battery',
                batteryId: id,
                value: soc,
                threshold: thresholds.lowBattery,
                message: `Low battery ${id}: ${soc.toFixed(0)}% (min: ${thresholds.lowBattery}%)`
              });
            }
          }
        });
      }

      // Engine temperature check (expects Kelvin values in many SK implementations)
      if (thresholds.highTemperature != null && data.propulsion) {
        Object.entries(data.propulsion).forEach(([engineId, engine]) => {
          let temperature = null;

          if (engine?.temperature != null) temperature = engine.temperature;
          else if (engine?.coolantTemperature != null) temperature = engine.coolantTemperature;
          else if (engine?.oilTemperature != null) temperature = engine.oilTemperature;

          if (typeof temperature === 'number') {
            const tempC = temperature - 273.15;
            if (tempC > thresholds.highTemperature) {
              alerts.push({
                type: 'high-engine-temp',
                engineId,
                value: tempC,
                threshold: thresholds.highTemperature,
                message: `High engine temp ${engineId}: ${tempC.toFixed(0)}°C (max: ${thresholds.highTemperature}°C)`
              });
            }
          }
        });
      }
    } catch (error) {
      this._error('Error checking critical values:', error);
    }

    return alerts;
  }

  // -------------------------
  // Helper / adapter methods
  // -------------------------

  /**
   * Try to find the subscription manager on the app object.
   * Returns either app.subscriptionmanager or app.signalk.subscriptionmanager or null.
   */
  _findSubscriptionManager() {
    if (this.app && this.app.subscriptionmanager) return this.app.subscriptionmanager;
    if (this.app && this.app.signalk && this.app.signalk.subscriptionmanager) return this.app.signalk.subscriptionmanager;
    return null;
  }

  /**
   * Safe wrapper to call app.handleMessage if available.
   * Some SK servers expose different APIs; this protects against crashes.
   * @private
   */
  _safeHandleMessage(msg) {
    try {
      if (!this.app) return;

      if (typeof this.app.handleMessage === 'function') {
        try {
          return this.app.handleMessage(this.pluginId, msg);
        } catch (_) {
          return this.app.handleMessage(msg);
        }
      } else if (this.app.signalk && typeof this.app.signalk.handleMessage === 'function') {
        try {
          return this.app.signalk.handleMessage(this.pluginId, msg);
        } catch (_) {
          return this.app.signalk.handleMessage(msg);
        }
      } else {
        this._debug('No handleMessage implementation found on app/signalk');
      }
    } catch (err) {
      this._error('Error in _safeHandleMessage:', err);
    }
  }

  /**
   * Emit safely via app.emit if available
   */
  _emitSafe(eventName, payload) {
    try {
      if (this.app && typeof this.app.emit === 'function') {
        this.app.emit(eventName, payload);
      } else if (this.app && this.app.signalk && typeof this.app.signalk.emit === 'function') {
        this.app.signalk.emit(eventName, payload);
      } else {
        this._debug('No emitter available to emit event', eventName, payload);
      }
    } catch (err) {
      this._error('Error emitting event', eventName, err);
    }
  }

  /**
   * Try to read a path value from the server via app.getSelfPath or app.signalk.getSelfPath
   * @param {string} path
   */
  _getSelfPath(path) {
    try {
      if (!this.app) return undefined;
      if (typeof this.app.getSelfPath === 'function') return this.app.getSelfPath(path);
      if (this.app.signalk && typeof this.app.signalk.getSelfPath === 'function') return this.app.signalk.getSelfPath(path);

      // Some servers expose a simple data object at app.signalk.server ? try conservative read
      if (this.app.signalk && this.app.signalk.server && typeof this.app.signalk.server.getSelfPath === 'function') {
        return this.app.signalk.server.getSelfPath(path);
      }
      return undefined;
    } catch (err) {
      this._error('Error reading self path', path, err);
      return undefined;
    }
  }

  /**
   * Write a value to a SignalK path
   * @param {string} path - The SignalK path to write to
   * @param {*} value - The value to write
   * @param {string} source - Optional source identifier
   */
  writePath(path, value, source = null) {
    try {
      const message = {
        context: 'vessels.self',
        updates: [{
          timestamp: new Date().toISOString(),
          source: source || {
            label: this.pluginId,
            type: 'plugin'
          },
          values: [{
            path: path,
            value: value
          }]
        }]
      };

      this._safeHandleMessage(message);
      this._debug(`Wrote value to path ${path}:`, value);
      return true;
    } catch (error) {
      this._error('Error writing to SignalK path:', path, error);
      return false;
    }
  }

  // small logging helpers to centralize debug/error
  _debug(...args) {
    try {
      if (this.app && typeof this.app.debug === 'function') this.app.debug(...args);
      else console.debug(...args);
    } catch (e) {
      // noop
    }
  }

  _error(...args) {
    try {
      if (this.app && typeof this.app.error === 'function') this.app.error(...args);
      else console.error(...args);
    } catch (e) {
      // noop
    }
  }
}

module.exports = SignalKDataProvider;
