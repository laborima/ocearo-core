/**
 * Common Utilities and Shared Functions
 *
 * Provides i18n, text utilities, unit conversions,
 * SignalK path constants, and default configuration.
 */

// Default configurations
const defaults = {
  language: 'en',
  profile: 'jarvis',
  units: {
    depth: 'm',
    speed: 'kn',
    distance: 'nm',
    temperature: 'F',
    wind: 'mph'
  }
};

// ---------------- TEXT UTILS ----------------
const textUtils = {
  /**
   * Clean text for TTS output — langue-aware.
   * En français: unités en toutes lettres, décimales avec virgule.
   * @param {string} text
   * @param {string} lang 'fr' | 'en'
   */
  cleanForTTS: (text = '', lang = 'en') => {
    try {
      let s = String(text)
        .replace(/[<>*_#`]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/&/g, lang === 'fr' ? 'et' : 'and')
        .trim();

      if (lang === 'fr') {
        s = s
          .replace(/(\d+)[.,](\d+)\s*kts?\b/gi, (_, a, b) => `${a} virgule ${b} nœuds`)
          .replace(/(\d+)\s*kts?\b/gi, (_, a) => `${a} nœuds`)
          .replace(/(\d+)[.,](\d+)\s*knots?\b/gi, (_, a, b) => `${a} virgule ${b} nœuds`)
          .replace(/(\d+)\s*knots?\b/gi, (_, a) => `${a} nœuds`)
          .replace(/(\d+)[.,](\d+)\s*km\/h\b/gi, (_, a, b) => `${a} virgule ${b} kilomètres par heure`)
          .replace(/(\d+)\s*km\/h\b/gi, (_, a) => `${a} kilomètres par heure`)
          .replace(/(\d+)[.,](\d+)\s*hPa\b/gi, (_, a, b) => `${a} virgule ${b} hectopascals`)
          .replace(/(\d+)\s*hPa\b/gi, (_, a) => `${a} hectopascals`)
          .replace(/(\d+)[.,](\d+)\s*m\b/gi, (_, a, b) => `${a} virgule ${b} mètres`)
          .replace(/(\d+)\s*m\b(?!\w)/gi, (_, a) => `${a} mètres`)
          .replace(/(\d+)[.,](\d+)\s*NM\b/gi, (_, a, b) => `${a} virgule ${b} milles nautiques`)
          .replace(/(\d+)\s*NM\b/gi, (_, a) => `${a} milles nautiques`)
          .replace(/(\d+)[.,](\d+)/g, (_, a, b) => `${a} virgule ${b}`)
          .replace(/°/g, ' degrés')
          .replace(/\bN\b/g, 'Nord').replace(/\bS\b/g, 'Sud')
          .replace(/\bE\b/g, 'Est').replace(/\bW\b/g, 'Ouest')
          .replace(/\bNE\b/g, 'Nord-Est').replace(/\bNW\b/g, 'Nord-Ouest')
          .replace(/\bSE\b/g, 'Sud-Est').replace(/\bSW\b/g, 'Sud-Ouest')
          .replace(/\bNNE\b/g, 'Nord-Nord-Est').replace(/\bNNW\b/g, 'Nord-Nord-Ouest')
          .replace(/\bSSE\b/g, 'Sud-Sud-Est').replace(/\bSSW\b/g, 'Sud-Sud-Ouest')
          .replace(/\bENE\b/g, 'Est-Nord-Est').replace(/\bESE\b/g, 'Est-Sud-Est')
          .replace(/\bWNW\b/g, 'Ouest-Nord-Ouest').replace(/\bWSW\b/g, 'Ouest-Sud-Ouest');
      } else {
        s = s
          .replace(/(\d+)[.,](\d+)/g, '$1 point $2')
          .replace(/°/g, ' degrees');
      }

      return s.replace(/\s+/g, ' ').trim();
    } catch (error) {
      console.error('Error in cleanForTTS:', error);
      return String(text || '');
    }
  },

  /**
   * Format number with precision
   */
  formatNumber: (value, decimals = 1, locale = 'en-US') => {
    if (typeof value !== 'number' || isNaN(value)) return 'N/A';
    try {
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      }).format(value);
    } catch (error) {
      console.error('Error in formatNumber:', error);
      return value.toFixed(decimals);
    }
  },

  /**
   * Format bearing to cardinal direction
   */
  bearingToCardinal: (bearing) => {
    if (typeof bearing !== 'number' || isNaN(bearing)) return 'N/A';
    const directions = [
      'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'
    ];
    const index = Math.round(bearing / 22.5) % 16;
    return directions[index];
  },

  /**
   * Alias for TTS - backwards compatibility
   * @param {string} text
   * @param {string} lang
   */
  formatTextForTTS: function(text, lang = 'en') {
    return this.cleanForTTS(text, lang);
  },

  /**
   * Truncate text to specified length
   */
  truncate: (text, maxLength = 100) => {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  },

  /**
   * Capitalize first letter
   */
  capitalize: (text) => {
    if (!text || typeof text !== 'string') return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
};

// ---------------- CONVERSIONS ----------------
const conversions = {
  // Length conversions
  metersToFeet: (m) => (typeof m === 'number' && !isNaN(m) ? m * 3.28084 : null),
  feetToMeters: (ft) => (typeof ft === 'number' && !isNaN(ft) ? ft / 3.28084 : null),

  // Speed conversions
  knotsToMs: (kn) => (typeof kn === 'number' && !isNaN(kn) ? kn * 0.514444 : null),
  msToKnots: (ms) => (typeof ms === 'number' && !isNaN(ms) ? ms * 1.94384 : null),
  knotsToKmh: (kn) => (typeof kn === 'number' && !isNaN(kn) ? kn * 1.852 : null),
  kmhToKnots: (kmh) => (typeof kmh === 'number' && !isNaN(kmh) ? kmh / 1.852 : null),

  // Distance conversions
  nmToKm: (nm) => (typeof nm === 'number' && !isNaN(nm) ? nm * 1.852 : null),
  kmToNm: (km) => (typeof km === 'number' && !isNaN(km) ? km / 1.852 : null),
  nmToMiles: (nm) => (typeof nm === 'number' && !isNaN(nm) ? nm * 1.15078 : null),
  milesToNm: (miles) => (typeof miles === 'number' && !isNaN(miles) ? miles / 1.15078 : null),

  // Temperature conversions
  celsiusToFahrenheit: (c) => (typeof c === 'number' && !isNaN(c) ? (c * 9) / 5 + 32 : null),
  fahrenheitToCelsius: (f) => (typeof f === 'number' && !isNaN(f) ? ((f - 32) * 5) / 9 : null),
  celsiusToKelvin: (c) => (typeof c === 'number' && !isNaN(c) ? c + 273.15 : null),
  kelvinToCelsius: (k) => (typeof k === 'number' && !isNaN(k) ? k - 273.15 : null),

  // Angle conversions
  radToDeg: (rad) => (typeof rad === 'number' && !isNaN(rad) ? rad * (180 / Math.PI) : null),
  degToRad: (deg) => (typeof deg === 'number' && !isNaN(deg) ? deg * (Math.PI / 180) : null),

  /**
   * Normalize angle to 0-360 degrees
   */
  normalizeAngle: (angle) => {
    if (typeof angle !== 'number' || isNaN(angle)) return null;
    angle = angle % 360;
    return angle < 0 ? angle + 360 : angle;
  },

  /**
   * Calculate difference between two angles (shortest path)
   */
  angleDifference: (angle1, angle2) => {
    if (typeof angle1 !== 'number' || typeof angle2 !== 'number') return null;
    let diff = angle2 - angle1;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return diff;
  }
};

// ---------------- CONTEXT FORMATTERS ----------------
const contextFormatters = {
  formatVesselState: (data = {}) => {
    const parts = [];

    try {
      if (data.navigation) {
        const nav = data.navigation;
        
        if (nav.speedOverGround != null) {
          const sog = conversions.msToKnots(nav.speedOverGround);
          if (sog !== null) {
            parts.push(`SOG: ${textUtils.formatNumber(sog)} kn`);
          }
        }
        
        if (nav.courseOverGroundTrue != null) {
          const cog = conversions.radToDeg(nav.courseOverGroundTrue);
          if (cog !== null) {
            const cogRounded = Math.round(cog);
            const cardinal = textUtils.bearingToCardinal(cog);
            parts.push(`COG: ${cogRounded}° (${cardinal})`);
          }
        }
        
        if (nav.headingTrue != null) {
          const hdg = conversions.radToDeg(nav.headingTrue);
          if (hdg !== null) {
            const hdgRounded = Math.round(hdg);
            const cardinalHdg = textUtils.bearingToCardinal(hdg);
            parts.push(`HDG: ${hdgRounded}° (${cardinalHdg})`);
          }
        }
      }

      if (data.environment) {
        const env = data.environment;
        
        if (env.depth?.belowKeel != null) {
          parts.push(`Depth: ${textUtils.formatNumber(env.depth.belowKeel)} m`);
        }
        
        if (env.wind) {
          if (env.wind.speedApparent != null) {
            const aws = conversions.msToKnots(env.wind.speedApparent);
            if (aws !== null) {
              parts.push(`AWS: ${textUtils.formatNumber(aws)} kn`);
            }
          }
          
          if (env.wind.angleApparent != null) {
            const awa = conversions.radToDeg(env.wind.angleApparent);
            if (awa !== null) {
              parts.push(`AWA: ${Math.round(awa)}°`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error formatting vessel state:', error);
    }

    return parts.join(', ');
  },

  formatTimestamp: (date = new Date()) => {
    try {
      return date.toISOString();
    } catch (error) {
      console.error('Error formatting timestamp:', error);
      return new Date().toISOString();
    }
  },

  formatTimeForSpeech: (date = new Date(), use24h = false, locale = 'en-US') => {
    try {
      return new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: !use24h
      }).format(date);
    } catch (error) {
      console.error('Error formatting time for speech:', error);
      return date.toLocaleTimeString();
    }
  },

  formatPositionForSpeech: (position) => {
    if (!position || typeof position.latitude !== 'number' || typeof position.longitude !== 'number') {
      return 'Position unknown';
    }

    try {
      const latDeg = Math.abs(position.latitude);
      const lonDeg = Math.abs(position.longitude);
      const latDir = position.latitude >= 0 ? 'North' : 'South';
      const lonDir = position.longitude >= 0 ? 'East' : 'West';
      
      return `${latDeg.toFixed(4)} degrees ${latDir}, ${lonDeg.toFixed(4)} degrees ${lonDir}`;
    } catch (error) {
      console.error('Error formatting position:', error);
      return 'Position format error';
    }
  }
};

// ---------------- I18N (DEPRECATED — use ConfigManager.t() instead) ----------------
const i18n = {
  translations: {
    en: {
      welcome: 'Welcome aboard',
      depth_warning: 'Warning: shallow water depth',
      wind_warning: 'Warning: strong wind conditions',
      battery_warning: 'Warning: low battery level',
      engine_warning: 'Warning: high engine temperature',
      navigation_update: 'Navigation update',
      current_conditions: 'Current conditions',
      recommendation: 'Recommendation',
      test_alert: 'This is a test alert',
      system_ready: 'Ocearo Jarvis system ready',
      system_error: 'System error detected',
      weather_high_wind: 'Warning: High wind speed of {speed} knots detected',
      weather_strong_wind: 'Caution: Strong wind of {speed} knots detected',
      weather_high_waves: 'Warning: High wave height of {height} meters',
      weather_current: 'Current conditions: wind {windSpeed} knots from {windDir}°, waves {waveHeight} meters',
      weather_unavailable: 'Weather data is currently unavailable',
      startup: {
        jarvis: 'Systems online. How may I assist you, Captain?',
        friend: 'Hey there! All systems are ready to go.',
        default: 'Océaro Jarvis initialized. All systems operational.'
      },
      shutdown: {
        jarvis: 'Systems going offline. Safe travels, Captain.',
        friend: 'Powering down. See you soon!',
        default: 'Océaro Jarvis shutting down. Safe travels.'
      },
      mode_changed: 'Operating mode changed to {mode}',
      mode: {
        auto: 'Auto',
        manual: 'Manual',
        standby: 'Standby'
      },
      vessel_mode: {
        sailing: 'Sailing',
        anchored: 'Anchored',
        motoring: 'Motoring',
        moored: 'Moored',
        racing: 'Racing'
      },
      alert_generic: 'Alert: {message}. Value: {value}',
      alert_depth: 'Depth alert: {value} meters',
      alert_wind: 'Wind alert: {value} knots',
      alert_battery: 'Battery alert: {value} volts',
      alert_engine: 'Engine alert: {value}',
      alert_temperature: 'Temperature alert: {value}',
      startup_analysis_complete: 'Startup analysis complete',
      analysis_failed: 'Unable to complete the requested analysis',
      // Tide
      tide_high: 'High',
      tide_low: 'Low',
      tide_rising: 'rising',
      tide_falling: 'falling',
      tide_unknown: 'unknown',
      no_alerts: 'No active alerts',
      active_alerts_count: 'You have {count} active alerts',
      // Status & Reports
      status_system: 'System status',
      status_active: 'Active',
      status_inactive: 'Inactive',
      status_mode: 'Mode',
      status_alerts_count: '{count} active alerts',
      status_ai_offline: 'Warning: AI assistant offline',
      status_logbook_offline: 'Note: Logbook offline',
      report_weather: 'Weather',
      report_tides: 'Tides',
      report_sail: 'Sail',
      report_tanks: 'Tanks',
      report_batteries: 'Batteries',
      report_tide_next: 'Next {type} at {time}',
      report_recommendations_count: '{count} recommendations',
      report_tanks_critical: '{count} critical',
      report_tanks_low: '{count} low',
      report_tanks_good: 'All levels good',
      report_batteries_attention: '{count} need attention',
      report_batteries_good: 'All levels good',
      logbook_no_entries: 'No logbook entries found to analyze',
      logbook_analysis_count: 'Analyzed {count} logbook entries',
      logbook_distance: 'Total distance covered',
      logbook_avg_speed: 'Average speed',
      logbook_engine_hours: 'Engine runtime',
      logbook_wind_increasing: 'Wind conditions have been increasing',
      logbook_monitor_weather: 'Monitor weather forecasts closely',
      logbook_engine_maintenance: 'Consider scheduling engine maintenance',
      logbook_entry_frequency: 'Consider making more frequent logbook entries',
      // Sail settings and recommendations
      sail_reef_needed: 'Reefing recommended',
      sail_reduce_heel: 'Reduce heel angle',
      sail_settings_ok: 'Sail settings are optimal',
      recommend_storm_preparation: 'Storm preparation recommended',
      recommend_sail_reduction: 'Reduce sail area',
      recommend_prepare_reef: 'Prepare to reef',
      recommend_course_change: 'Course change advised',
      recommend_trim_adjustment: 'Trim adjustment recommended',
      // Navigation point
      nav_point_update: 'Navigation update: Speed {speed} knots, Course {course}°, Depth {depth} meters',
      nav_point_no_data: 'Navigation data unavailable',
      // Hourly logbook
      hourly_log_entry: 'Hourly log entry recorded',
      hourly_log_summary: 'Position: {position}, Speed: {speed} knots, Course: {course}°'
    },
    fr: {
      welcome: 'Bienvenue à bord',
      depth_warning: 'Attention: faible profondeur sous la quille',
      wind_warning: 'Attention: conditions de vent fort',
      battery_warning: 'Attention: niveau de batterie faible',
      engine_warning: 'Attention: surchauffe moteur détectée',
      navigation_update: 'Point de navigation',
      current_conditions: 'Conditions actuelles',
      recommendation: 'Recommandation',
      test_alert: 'Ceci est une alerte de test',
      system_ready: 'Système Océaro Jarvis opérationnel',
      system_error: 'Erreur système détectée',
      weather_high_wind: 'Avertissement: vent fort de {speed} nœuds détecté',
      weather_strong_wind: 'Attention: vent soutenu de {speed} nœuds détecté',
      weather_high_waves: 'Avertissement: houle importante de {height} mètres',
      weather_current: 'Conditions actuelles: vent de {windSpeed} nœuds du {windDir}°, houle de {waveHeight} mètres',
      weather_unavailable: 'Données météorologiques indisponibles',
      startup: {
        jarvis: 'Systèmes en ligne. À vos ordres, Capitaine.',
        friend: 'Salut ! Tous les systèmes sont prêts.',
        default: 'Océaro Jarvis initialisé. Systèmes opérationnels.'
      },
      shutdown: {
        jarvis: 'Arrêt des systèmes. Bon vent, Capitaine.',
        friend: 'Extinction. À bientôt !',
        default: 'Océaro Jarvis s\'arrête. Au revoir.'
      },
      mode_changed: 'Mode opératoire passé en {mode}',
      mode: {
        auto: 'Automatique',
        manual: 'Manuel',
        standby: 'Veille'
      },
      vessel_mode: {
        sailing: 'Navigation à la voile',
        anchored: 'Au mouillage',
        motoring: 'Navigation au moteur',
        moored: 'À quai',
        racing: 'En régate'
      },
      // Sail settings translations
      sail_reef_needed: 'Prise de ris recommandée',
      sail_reduce_heel: 'Réduire la gîte',
      sail_settings_ok: 'Réglages de voile optimaux',
      recommend_storm_preparation: 'Préparation tempête recommandée',
      recommend_sail_reduction: 'Réduire la voilure',
      recommend_prepare_reef: 'Préparer un ris',
      recommend_course_change: 'Changement de cap conseillé',
      recommend_trim_adjustment: 'Ajustement des réglages conseillé',
      // Alert specific
      alert_generic: 'Alerte: {message}. Valeur: {value}',
      alert_depth: 'Alerte profondeur: {value} mètres',
      alert_wind: 'Alerte vent: {value} nœuds',
      alert_battery: 'Alerte batterie: {value} volts',
      alert_engine: 'Alerte moteur: {value}',
      alert_temperature: 'Alerte température: {value}',
      startup_analysis_complete: 'Analyse de démarrage terminée',
      analysis_failed: 'Impossible de terminer l\'analyse demandée',
      // Tide
      tide_high: 'Pleine mer',
      tide_low: 'Basse mer',
      tide_rising: 'montante',
      tide_falling: 'descendante',
      tide_unknown: 'inconnue',
      no_alerts: 'Aucune alerte active',
      active_alerts_count: 'Vous avez {count} alertes actives',
      // Status & Reports
      status_system: 'État du système',
      status_active: 'Actif',
      status_inactive: 'Inactif',
      status_mode: 'Mode',
      status_alerts_count: '{count} alertes actives',
      status_ai_offline: 'Attention: Assistant IA hors ligne',
      status_logbook_offline: 'Note: Journal de bord hors ligne',
      report_weather: 'Météo',
      report_tides: 'Marées',
      report_sail: 'Voile',
      report_tanks: 'Réservoirs',
      report_batteries: 'Batteries',
      report_tide_next: 'Prochaine {type} à {time}',
      report_recommendations_count: '{count} recommandations',
      report_tanks_critical: '{count} critiques',
      report_tanks_low: '{count} bas',
      report_tanks_good: 'Niveaux corrects',
      report_batteries_attention: '{count} nécessitent attention',
      report_batteries_good: 'Niveaux corrects',
      logbook_no_entries: 'Aucune entrée trouvée dans le journal',
      logbook_analysis_count: '{count} entrées analysées',
      logbook_distance: 'Distance totale parcourue',
      logbook_avg_speed: 'Vitesse moyenne',
      logbook_engine_hours: 'Temps moteur',
      logbook_wind_increasing: 'Les conditions de vent se renforcent',
      logbook_monitor_weather: 'Surveillez attentivement les prévisions météo',
      logbook_engine_maintenance: 'Envisagez une maintenance moteur',
      logbook_entry_frequency: 'Pensez à faire des entrées plus fréquentes',
      // Navigation point
      nav_point_update: 'Point navigation: Vitesse {speed} nœuds, Cap {course}°, Profondeur {depth} mètres',
      nav_point_no_data: 'Données de navigation indisponibles',
      // Hourly logbook
      hourly_log_entry: 'Entrée horaire enregistrée',
      hourly_log_summary: 'Position: {position}, Vitesse: {speed} nœuds, Cap: {course}°'
    }
  },

  /**
   * Get localized string with fallback chain
   * Supports nested keys like 'vessel_mode.sailing'
   */
  t: (key, language = 'en') => {
    try {
      const langs = [language, language.split('-')[0], 'en'];
      for (const lang of langs) {
        const dict = i18n.translations[lang];
        if (!dict) continue;
        
        // Support nested keys
        const keys = key.split('.');
        let value = dict;
        for (const k of keys) {
          if (value && typeof value === 'object') {
            value = value[k];
          } else {
            value = undefined;
            break;
          }
        }
        
        if (value !== undefined && typeof value === 'string') {
          return value;
        }
      }
      return key;
    } catch (error) {
      console.error('Error in translation:', error);
      return key;
    }
  },

  /**
   * Localize with variable substitution
   */
  localize: (language, key, variables = {}) => {
    try {
      let text = i18n.t(key, language);
      Object.entries(variables).forEach(([varKey, val]) => {
        text = text.replace(new RegExp(`{${varKey}}`, 'g'), String(val));
      });
      return text;
    } catch (error) {
      console.error('Error in localization:', error);
      return key;
    }
  },

  /**
   * Get available languages
   */
  getAvailableLanguages: () => Object.keys(i18n.translations)
};

// ---------------- SK PATHS ----------------
const skPaths = {
  navigation: {
    speedOverGround: 'navigation.speedOverGround',
    courseOverGroundTrue: 'navigation.courseOverGroundTrue',
    courseOverGroundMagnetic: 'navigation.courseOverGroundMagnetic',
    headingTrue: 'navigation.headingTrue',
    headingMagnetic: 'navigation.headingMagnetic',
    position: 'navigation.position',
    destination: 'navigation.destination',
    rateOfTurn: 'navigation.rateOfTurn'
  },
  environment: {
    depthBelowKeel: 'environment.depth.belowKeel',
    depthBelowTransducer: 'environment.depth.belowTransducer',
    depthBelowSurface: 'environment.depth.belowSurface',
    wind: {
      speedApparent: 'environment.wind.speedApparent',
      angleApparent: 'environment.wind.angleApparent',
      speedTrue: 'environment.wind.speedTrue',
      angleTrue: 'environment.wind.angleTrue',
      angleTrueWater: 'environment.wind.angleTrueWater',
      directionTrue: 'environment.wind.directionTrue'
    },
    water: {
      temperature: 'environment.water.temperature'
    },
    outside: {
      airTemperature: 'environment.outside.temperature',
      pressure: 'environment.outside.pressure',
      humidity: 'environment.outside.humidity'
    }
  },
  electrical: {
    batteries: 'electrical.batteries',
    shore: 'electrical.shore',
    solar: 'electrical.solar',
    inverters: 'electrical.inverters'
  },
  propulsion: {
    mainEngine: 'propulsion.mainEngine',
    port: 'propulsion.port',
    starboard: 'propulsion.starboard'
  },
  notifications: 'notifications',
  ocearo: {
    context: 'ocearo.context',
    brief: 'ocearo.brief',
    logbook: 'ocearo.logbook',
    mode: 'ocearo.mode',
    persona: 'ocearo.persona',
    language: 'ocearo.language',
    sailAdvice: 'ocearo.sailAdvice',
    status: 'ocearo.status'
  }
};


// ---------------- NOTIFICATIONS ----------------
const notifications = {
  create: (path, message, state = 'alert', method = ['visual', 'sound']) => ({
    path: `vessels.self.notifications.${path}`,
    value: {
      state,
      method: Array.isArray(method) ? method : [method],
      message: String(message),
      timestamp: new Date().toISOString(),
      source: 'ocearo-core'
    }
  }),

  clear: (path) => ({
    path: `vessels.self.notifications.${path}`,
    value: null
  }),

  extractTopic: (path) => {
    const match = path.match(/notifications\.(.+)/);
    return match ? match[1] : null;
  },

  /**
   * Create system notification
   */
  createSystem: (type, message, priority = 'normal') => {
    const states = {
      info: 'normal',
      warning: 'alert',
      error: 'emergency',
      critical: 'emergency'
    };
    
    return notifications.create(
      `system.${type}`,
      message,
      states[priority] || 'normal',
      priority === 'critical' ? ['visual', 'sound'] : ['visual']
    );
  }
};

// ---------------- ERROR HANDLING ----------------
const errorHandler = {
  /**
   * Create standardized error response
   */
  createError: (message, code = 'INTERNAL_ERROR', details = null) => ({
    error: true,
    code,
    message: String(message),
    details,
    timestamp: new Date().toISOString()
  }),

  /**
   * Handle async operations with consistent error handling
   */
  handleAsync: async (operation, context = '') => {
    try {
      return await operation();
    } catch (error) {
      const errorMsg = context ? `${context}: ${error.message}` : error.message;
      throw new Error(errorMsg);
    }
  },

  /**
   * Safe async wrapper that won't throw
   */
  safeAsync: async (operation, fallback = null) => {
    try {
      return await operation();
    } catch (error) {
      console.error('Safe async operation failed:', error);
      return fallback;
    }
  },

  /**
   * Validate required parameters
   */
  validateRequired: (params, requiredFields) => {
    const missing = requiredFields.filter(field => 
      params[field] === undefined || params[field] === null
    );
    if (missing.length > 0) {
      throw new Error(`Missing required parameters: ${missing.join(', ')}`);
    }
  },

  /**
   * Validate parameter types
   */
  validateType: (value, type, fieldName) => {
    if (typeof value !== type) {
      throw new Error(`Invalid type for ${fieldName}: expected ${type}, got ${typeof value}`);
    }
  },

  /**
   * Validate string length
   */
  validateLength: (value, min = 0, max = Infinity, fieldName = 'string') => {
    if (typeof value !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }
    if (value.length < min) {
      throw new Error(`${fieldName} too short (min ${min} characters)`);
    }
    if (value.length > max) {
      throw new Error(`${fieldName} too long (max ${max} characters)`);
    }
  },

  /**
   * Validate numeric range
   */
  validateRange: (value, min = -Infinity, max = Infinity, fieldName = 'number') => {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error(`${fieldName} must be a valid number`);
    }
    if (value < min) {
      throw new Error(`${fieldName} too small (min ${min})`);
    }
    if (value > max) {
      throw new Error(`${fieldName} too large (max ${max})`);
    }
  }
};

// ---------------- UTILITIES ----------------
const utils = {
  /**
   * Deep merge objects
   */
  deepMerge: (target, ...sources) => {
    if (!sources.length) return target;
    const source = sources.shift();

    if (utils.isObject(target) && utils.isObject(source)) {
      for (const key in source) {
        if (utils.isObject(source[key])) {
          if (!target[key]) Object.assign(target, { [key]: {} });
          utils.deepMerge(target[key], source[key]);
        } else {
          Object.assign(target, { [key]: source[key] });
        }
      }
    }

    return utils.deepMerge(target, ...sources);
  },

  /**
   * Check if value is object
   */
  isObject: (item) => item && typeof item === 'object' && !Array.isArray(item),

  /**
   * Debounce function
   */
  debounce: (func, wait, immediate = false) => {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        timeout = null;
        if (!immediate) func(...args);
      };
      const callNow = immediate && !timeout;
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) func(...args);
    };
  },

  /**
   * Throttle function
   */
  throttle: (func, limit) => {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  /**
   * Generate UUID
   */
  generateUUID: () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
};

// Export all modules
module.exports = {
  defaults,
  textUtils,
  conversions,
  contextFormatters,
  i18n,
  skPaths,
  notifications,
  errorHandler,
  utils
};