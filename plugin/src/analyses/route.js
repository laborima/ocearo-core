/**
 * Route Planning Analysis Module
 *
 * Intelligent route planning and navigation assistance.
 * Analyzes weather forecasts, vessel polar performance, and destination
 * to recommend optimal routing strategies.
 */

class RoutePlanner {
    constructor(app, config, llm, cm) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        this.cm = cm;
    }

    /**
     * Analyze route to destination
     * @param {object} vesselData Current vessel data
     * @param {object} weatherData Weather forecast data
     * @param {object} context Navigation context containing destination
     * @returns {object} Route planning analysis
     */
    async planRoute(vesselData, weatherData, context) {
        try {
            if (!context || !context.destination || !context.destination.position) {
                return {
                    status: 'no_destination',
                    message: this.cm.t('route.no_destination') || 'No destination set.',
                    analysis: null
                };
            }

            const destination = context.destination.position;
            const currentPosition = vesselData.position;

            if (!currentPosition || !currentPosition.latitude || !currentPosition.longitude) {
                return {
                    status: 'no_position',
                    message: this.cm.t('route.no_position') || 'Current position unknown.',
                    analysis: null
                };
            }

            const distance = this._calculateDistance(currentPosition, destination);
            const bearing = this._calculateBearing(currentPosition, destination);

            // Estimate time based on current speed or average polar speed
            const speed = vesselData.speed > 0.5 ? vesselData.speed : 5; // fallback to 5 knots
            const estimatedTimeHours = distance / (speed * 1.94384); // Distance in meters, speed in m/s, wait distance is likely in NM if we convert... 
            // Let's use haversine in NM
            
            const distanceNM = this._haversineDistanceNM(currentPosition, destination);
            const speedKts = vesselData.speed * 1.94384;
            const avgSpeed = speedKts > 1 ? speedKts : 5;
            const etaHours = distanceNM / avgSpeed;

            let expertAdvice = [];
            let llmAnalysis = null;

            if (this.config.sailing?.useLLMAnalysis !== false && this.llm.isConnected()) {
                llmAnalysis = await this.generateRouteAnalysis(vesselData, weatherData, destination, distanceNM, bearing, etaHours);
            }

            return {
                status: 'planned',
                destination,
                distanceNM: Math.round(distanceNM * 10) / 10,
                bearing: Math.round(bearing),
                etaHours: Math.round(etaHours * 10) / 10,
                expertAdvice,
                analysis: llmAnalysis,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Route planning failed:', error);
            return this.getFallbackAnalysis();
        }
    }

    _haversineDistanceNM(pos1, pos2) {
        const toRad = x => x * Math.PI / 180;
        const R = 3440.065; // Radius of Earth in nautical miles
        const dLat = toRad(pos2.latitude - pos1.latitude);
        const dLon = toRad(pos2.longitude - pos1.longitude);
        const lat1 = toRad(pos1.latitude);
        const lat2 = toRad(pos2.latitude);

        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    _calculateBearing(pos1, pos2) {
        const toRad = x => x * Math.PI / 180;
        const toDeg = x => x * 180 / Math.PI;
        
        const lat1 = toRad(pos1.latitude);
        const lat2 = toRad(pos2.latitude);
        const dLon = toRad(pos2.longitude - pos1.longitude);

        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                  Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        const brng = toDeg(Math.atan2(y, x));
        return (brng + 360) % 360;
    }

    async generateRouteAnalysis(vesselData, weatherData, destination, distanceNM, bearing, etaHours) {
        try {
            const isFrench = this.cm.language === 'fr';
            
            let prompt = isFrench 
                ? `Planification de route IA. Destination à ${distanceNM.toFixed(1)} NM, cap ${Math.round(bearing)}°. ETA: ${etaHours.toFixed(1)}h. `
                : `AI Route Planning. Destination at ${distanceNM.toFixed(1)} NM, bearing ${Math.round(bearing)}°. ETA: ${etaHours.toFixed(1)}h. `;
                
            const windSpeed = weatherData?.current?.windSpeed || vesselData.wind?.speed || 0;
            const windDir = weatherData?.current?.windDirection || vesselData.wind?.direction || 0;
            
            prompt += isFrench 
                ? `Vent: ${windSpeed} nds, Direction: ${windDir}°. `
                : `Wind: ${windSpeed} kts, Direction: ${windDir}°. `;
                               
            prompt += isFrench 
                ? `Fournis une stratégie de routage optimale, en tenant compte des polaires du navire, des dangers potentiels, et des allures recommandées.`
                : `Provide an optimal routing strategy, considering vessel polars, potential dangers, and recommended points of sail.`;

            const result = await this.llm.generateDualOutput(prompt, { temperature: 0.4 });
            return result;
        } catch (error) {
            this.app.debug('LLM route analysis failed:', error.message);
            return null;
        }
    }

    getFallbackAnalysis() {
        return {
            status: 'unknown',
            distanceNM: 0,
            bearing: 0,
            etaHours: 0,
            expertAdvice: [],
            analysis: null,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = RoutePlanner;
