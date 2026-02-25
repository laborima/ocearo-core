/**
 * Failure Prediction Analysis Module
 *
 * Proactively monitors vessel systems (engine, electrical, etc.)
 * to predict potential failures before they occur.
 *
 * Features:
 * - Battery health and discharge rate analysis
 * - Engine temperature and pressure trend monitoring
 * - Maintenance schedule tracking (based on engine hours)
 * - LLM-powered anomaly detection
 */

class FailurePredictor {
    constructor(app, config, llm, cm) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        this.cm = cm;

        // Baselines and thresholds
        this.thresholds = {
            battery: {
                minVoltage: 11.8,
                rapidDischargeA: -15, // Amps
                criticalTimeToEmpty: 3600 * 4 // 4 hours in seconds
            },
            engine: {
                maxTemp: 368.15, // 95°C in Kelvin
                minOilPressure: 100000, // 1 bar in Pascals
                serviceInterval: 3600 * 100 // 100 hours in seconds
            }
        };

        this.history = {
            engineTemp: [],
            batteryVoltage: []
        };
    }

    /**
     * Analyze systems for potential failures
     * @param {object} vesselData Current vessel data
     * @returns {object} Failure prediction analysis
     */
    async analyzeSystems(vesselData) {
        try {
            const issues = [];
            const warnings = [];

            this._checkElectricalSystems(vesselData, issues, warnings);
            this._checkPropulsionSystems(vesselData, issues, warnings);

            const hasRisks = issues.length > 0 || warnings.length > 0;
            
            let expertAdvice = [];
            let llmAnalysis = null;

            if (hasRisks) {
                expertAdvice = this._generateExpertAdvice(issues, warnings);
                
                if (this.config.sailing?.useLLMAnalysis !== false && this.llm.isConnected()) {
                    llmAnalysis = await this.generateFailureAnalysis(vesselData, issues, warnings);
                }
            }

            return {
                status: hasRisks ? 'at_risk' : 'healthy',
                issues,
                warnings,
                expertAdvice,
                analysis: llmAnalysis,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Failure prediction analysis failed:', error);
            return this.getFallbackAnalysis();
        }
    }

    _checkElectricalSystems(vesselData, issues, warnings) {
        if (!vesselData.electrical || !vesselData.electrical.batteries) return;

        for (const [id, battery] of Object.entries(vesselData.electrical.batteries)) {
            // Check voltage
            if (battery.voltage !== undefined) {
                if (battery.voltage < this.thresholds.battery.minVoltage) {
                    issues.push({ system: `battery_${id}`, type: 'low_voltage', value: battery.voltage });
                } else if (battery.voltage < this.thresholds.battery.minVoltage + 0.4) {
                    warnings.push({ system: `battery_${id}`, type: 'voltage_dropping', value: battery.voltage });
                }
            }

            // Check discharge rate
            if (battery.current !== undefined && battery.current < this.thresholds.battery.rapidDischargeA) {
                warnings.push({ system: `battery_${id}`, type: 'rapid_discharge', value: battery.current });
            }

            // Check time to empty
            if (battery.capacity?.timeToEmpty !== undefined && battery.capacity.timeToEmpty < this.thresholds.battery.criticalTimeToEmpty) {
                issues.push({ system: `battery_${id}`, type: 'critical_time_to_empty', value: battery.capacity.timeToEmpty });
            }
        }
    }

    _checkPropulsionSystems(vesselData, issues, warnings) {
        if (!vesselData.propulsion) return;

        for (const [id, engine] of Object.entries(vesselData.propulsion)) {
            // Temperature check
            if (engine.temperature !== undefined) {
                if (engine.temperature > this.thresholds.engine.maxTemp) {
                    issues.push({ system: `engine_${id}`, type: 'overheating', value: engine.temperature });
                } else if (engine.temperature > this.thresholds.engine.maxTemp - 5) {
                    warnings.push({ system: `engine_${id}`, type: 'temp_rising', value: engine.temperature });
                }
            }

            // Oil pressure check
            if (engine.oilPressure !== undefined && engine.oilPressure < this.thresholds.engine.minOilPressure) {
                issues.push({ system: `engine_${id}`, type: 'low_oil_pressure', value: engine.oilPressure });
            }

            // Service interval check
            if (engine.runTime !== undefined) {
                const hoursSinceService = (engine.runTime % this.thresholds.engine.serviceInterval) / 3600;
                if (hoursSinceService > 90) { // Warning 10 hours before service
                    warnings.push({ system: `engine_${id}`, type: 'service_due_soon', value: hoursSinceService });
                }
            }
        }
    }

    _generateExpertAdvice(issues, warnings) {
        const advice = [];
        
        issues.forEach(issue => {
            advice.push({
                type: 'critical_failure_risk',
                priority: 'critical',
                message: this.cm.t(`failure.advice.${issue.type}`) || `Critical issue detected on ${issue.system}: ${issue.type}`
            });
        });

        warnings.forEach(warning => {
            advice.push({
                type: 'preventive_maintenance',
                priority: 'high',
                message: this.cm.t(`failure.advice.${warning.type}`) || `Warning on ${warning.system}: ${warning.type}. Check system.`
            });
        });

        return advice;
    }

    async generateFailureAnalysis(vesselData, issues, warnings) {
        try {
            const isFrench = this.cm.language === 'fr';
            
            let prompt = isFrench 
                ? `Analyse prédictive de pannes. Navire: Vitesse ${vesselData.speed || '?'} nds. `
                : `Predictive failure analysis. Vessel: Speed ${vesselData.speed || '?'} kts. `;
                
            prompt += isFrench ? `Problèmes critiques: ${JSON.stringify(issues)}. Avertissements: ${JSON.stringify(warnings)}. ` 
                               : `Critical issues: ${JSON.stringify(issues)}. Warnings: ${JSON.stringify(warnings)}. `;
                               
            prompt += isFrench ? `Identifie la cause probable de ces anomalies et donne une action immédiate à réaliser pour éviter la panne.`
                               : `Identify the probable cause of these anomalies and provide an immediate action to prevent failure.`;

            const result = await this.llm.generateDualOutput(prompt, { temperature: 0.3 });
            return result;
        } catch (error) {
            this.app.debug('LLM failure analysis failed:', error.message);
            return null;
        }
    }

    getFallbackAnalysis() {
        return {
            status: 'unknown',
            issues: [],
            warnings: [],
            expertAdvice: [],
            analysis: null,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = FailurePredictor;
