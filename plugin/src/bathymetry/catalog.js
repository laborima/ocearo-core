/**
 * src/bathymetry/catalog.js
 *
 * SHOM digital elevation models (MNT topo-bathymétriques, HOMONIM / TANDEM
 * projects) published as open data (Licence Ouverte Etalab 2.0) on
 * data.shom.fr. Every product here is the version referenced to chart datum
 * (PBMA, "plus basses mers astronomiques"): elevations are metres above the
 * lowest astronomical tide, so the depth at a moment is the tide height
 * (Signal K environment.tide.heightNow, also above chart datum) minus the
 * elevation, as on a paper chart.
 *
 * Coastal models (5 – 20 m) are downloaded whole; the 100 m façade models
 * cover whole seaboards and are cropped to an area around the boat when
 * imported. Bounding boxes come from the data.gouv.fr records.
 */

const BASE = 'https://services.data.shom.fr/INSPIRE/telechargement/prepackageGroup';

/**
 * @typedef {object} ShomDataset
 * @property {string} id
 * @property {string} name
 * @property {'coastal'|'facade'} kind
 * @property {number} resolutionM  nominal cell size, metres
 * @property {[number, number, number, number]} bbox  west, south, east, north (degrees)
 * @property {string} url  7z archive with an ESRI ASCII grid
 */

/** @type {ShomDataset[]} */
const SHOM_DATASETS = [
    // ── Coastal, 5 – 20 m ────────────────────────────────────────────────────
    { id: 'ile-de-re', name: 'Abords de l\'île de Ré', kind: 'coastal', resolutionM: 5,
        bbox: [-1.713, 46.135, -1.455, 46.308],
        url: `${BASE}/MNT_COTIER_ILE_DE_RE_5m_PBMA_PACK_DL/prepackage/MNT_COTIER_ILE_DE_RE_HOMONIM_PBMA/file/MNT_COTIER_ILE_DE_RE_HOMONIM_PBMA.7z` },
    { id: 'port-saint-malo', name: 'Port de Saint-Malo', kind: 'coastal', resolutionM: 5,
        bbox: [-2.11, 48.61, -1.98, 48.69],
        url: `${BASE}/MNT_COTIER_PORT_SM_PAPI_SM_5m_PACK_DL/prepackage/MNT_COTIER_PORT_SAINT-MALO_PAPI_PBMA/file/MNT_COTIER_PORT_SAINT-MALO_PAPI_PBMA.7z` },
    { id: 'port-boulogne', name: 'Port de Boulogne-sur-Mer', kind: 'coastal', resolutionM: 10,
        bbox: [1.512, 50.695, 1.622, 50.795],
        url: `${BASE}/MNT_COTIER_PORT_BSM_TANDEM_10m_PBMA_4326_PACK_DL/prepackage/MNT_COTIER_PORT_BSM_TANDEM_PBMA/file/MNT_COTIER_PORT_BSM_TANDEM_PBMA.7z` },
    { id: 'pertuis-charentais', name: 'Pertuis charentais', kind: 'coastal', resolutionM: 20,
        bbox: [-1.7, 45.75, -0.95, 46.45],
        url: `${BASE}/MNT_COTIER_PERTUIS_HOMONIM_20m_PBMA_4326_PACK_DL/prepackage/MNT_COTIER_PERTUIS_HOMONIM_PBMA/file/MNT_COTIER_PERTUIS_HOMONIM_PBMA.7z` },
    { id: 'gironde-aval', name: 'Estuaire de la Gironde (aval)', kind: 'coastal', resolutionM: 20,
        bbox: [-1.5, 45.185, -0.65, 45.75],
        url: `${BASE}/MNT_COTIER_GIRONDE_AVAL_20m_PACK_DL/prepackage/MNT_COTIER_ESTUAIRE_GIRONDE_AVAL_HOMONIM_PBMA/file/MNT_COTIER_ESTUAIRE_GIRONDE_AVAL_HOMONIM_PBMA.7z` },
    { id: 'gironde-amont', name: 'Estuaire de la Gironde (amont)', kind: 'coastal', resolutionM: 20,
        bbox: [-0.809, 44.806, -0.255, 45.185],
        url: `${BASE}/MNT_COTIER_GIRONDE_AMONT_HOMONIM_20m_PBMA_4326_PACK_DL/prepackage/MNT_COTIER_GIRONDE_AMONT_HOMONIM_PBMA/file/MNT_COTIER_GIRONDE_AMONT_HOMONIM_PBMA.7z` },
    { id: 'arcachon', name: 'Bassin d\'Arcachon', kind: 'coastal', resolutionM: 20,
        bbox: [-1.4, 44.44, -0.96, 45.18],
        url: `${BASE}/MNT_COTIER_ARCACHON_HOMONIM_20m_PACK_DL/prepackage/MNT_COTIER_ARCACHON_HOMONIM_20m_PACK_DL/file/MNT_COTIER_ARCACHON_HOMONIM_PBMA.7z` },
    { id: 'saint-jean-de-luz', name: 'Baie de Saint-Jean-de-Luz', kind: 'coastal', resolutionM: 20,
        bbox: [-1.734, 43.374, -1.611, 43.455],
        url: `${BASE}/MNT_COTIER_BAIE_SJL_TANDEM_20m_PACK_DL/prepackage/MNT_COTIER_BAIE_SAINT_JEAN_DE_LUZ_TANDEM_PBMA/file/MNT_COTIER_BAIE_SAINT_JEAN_DE_LUZ_TANDEM_PBMA.7z` },
    { id: 'morbihan', name: 'Morbihan', kind: 'coastal', resolutionM: 20,
        bbox: [-3.33, 47.2, -2.37, 47.725],
        url: `${BASE}/MNT_COTIER_MORBIHAN_TANDEM_20m_PBMA_4326_PACK_DL/prepackage/MNT_COTIER_MORBIHAN_TANDEM_PBMA/file/MNT_COTIER_MORBIHAN_TANDEM_PBMA.7z` },
    { id: 'golfe-normand-breton', name: 'Golfe normand-breton', kind: 'coastal', resolutionM: 20,
        bbox: [-2.15, 48.55, -1.3, 48.95],
        url: `${BASE}/MNT_COTIER_GNB_PAPI_SM_20m_PACK_DL/prepackage/MNT_COTIER_GNB_PAPI_SM_20m_PACK_DL/file/MNT_COTIER_GOLFE_NORMAND_BRETON_PAPI_PBMA.7z` },
    { id: 'pas-de-calais', name: 'Détroit du Pas-de-Calais', kind: 'coastal', resolutionM: 20,
        bbox: [0.834, 50.5, 2.543, 51.333],
        url: `${BASE}/MNT_COTIER_DETROIT_PDC_20m_TANDEM_PACK_DL/prepackage/MNT_COTIER_DETROIT_PAS-DE-CALAIS_TANDEM_PBMA/file/MNT_COTIER_DETROIT_PAS-DE-CALAIS_TANDEM_PBMA.7z` },
    { id: 'tahiti', name: 'Tahiti', kind: 'coastal', resolutionM: 20,
        bbox: [-149.64, -17.91, -149.11, -17.47],
        url: `${BASE}/MNT_COTIER_TAHITI_20m_PACK_DL/prepackage/MNT_COTIER_TAHITI_METEO-FRANCE_PBMA/file/MNT_COTIER_TAHITI_METEO-FRANCE_PBMA.7z` },
    { id: 'moorea', name: 'Moorea', kind: 'coastal', resolutionM: 20,
        bbox: [-149.94, -17.62, -149.74, -17.46],
        url: `${BASE}/MNT_COTIER_MOOREA_20m_PACK_DL/prepackage/MNT_COTIER_MOOREA_METEO-FRANCE_PBMA/file/MNT_COTIER_MOOREA_METEO-FRANCE_PBMA.7z` },

    // ── Façades, 100 m (cropped around the boat on import) ───────────────────
    { id: 'facade-atlantique', name: 'Façade Atlantique – Manche – mer du Nord', kind: 'facade', resolutionM: 100,
        bbox: [-6.0, 43.25, 5.85, 52.9],
        url: `${BASE}/MNT_ATL100m_HOMONIM_PBMA_4326_PACK_DL/prepackage/MNT_FACADE_ATLANTIQUE_HOMONIM_PBMA/file/MNT_FACADE_ATLANTIQUE_HOMONIM_PBMA.7z` },
    { id: 'facade-golfe-du-lion', name: 'Golfe du Lion – Côte d\'Azur', kind: 'facade', resolutionM: 100,
        bbox: [2.9, 41.7, 7.9, 44.4],
        url: `${BASE}/MNT_MED100m_GDL_CA_HOMONIM_PBMA_4326_PACK_DL/prepackage/MNT_FACADE_GDL-CA_HOMONIM_PBMA/file/MNT_FACADE_GDL-CA_HOMONIM_PBMA.7z` },
    { id: 'facade-antilles-sud', name: 'Guadeloupe – Martinique', kind: 'facade', resolutionM: 100,
        bbox: [-62.3, 14.1, -60.3, 16.9],
        url: `${BASE}/MNT_ANTS100m_HOMONIM_PACK_DL/prepackage/MNT_FACADE_ANTS_HOMONIM_PBMA/file/MNT_FACADE_ANTS_HOMONIM_PBMA.7z` },
    { id: 'facade-antilles-nord', name: 'Saint-Martin – Saint-Barthélemy', kind: 'facade', resolutionM: 100,
        bbox: [-63.5, 17.6, -62.5, 18.5],
        url: `${BASE}/MNT_ANTN100m_HOMONIM_PACK_DL/prepackage/MNT_FACADE_ANTN_HOMONIM_PBMA/file/MNT_FACADE_ANTN_HOMONIM_PBMA.7z` },
    { id: 'facade-guyane', name: 'Guyane', kind: 'facade', resolutionM: 100,
        bbox: [-54.75, 3.25, -49.75, 8.0],
        url: `${BASE}/MNT_GUY100m_HOMONIM_PACK_DL/prepackage/MNT_FACADE_GUYANE_HOMONIM_PBMA/file/MNT_FACADE_GUYANE_HOMONIM_PBMA.7z` },
    { id: 'facade-reunion', name: 'La Réunion', kind: 'facade', resolutionM: 100,
        bbox: [54.5, -22.0, 56.5, -20.25],
        url: `${BASE}/MNT_REU100m_HOMONIM_PACK_DL/prepackage/MNT_FACADE_REUNION_HOMONIM_PBMA/file/MNT_FACADE_REUNION_HOMONIM_PBMA.7z` },
    { id: 'facade-mayotte', name: 'Mayotte', kind: 'facade', resolutionM: 100,
        bbox: [44.5, -13.5, 45.75, -12.25],
        url: `${BASE}/MNT_MAY100m_HOMONIM_PACK_DL/prepackage/MNT_FACADE_MAYOTTE_HOMONIM_PBMA/file/MNT_FACADE_MAYOTTE_HOMONIM_PBMA.7z` },
];

/** Does a bounding box intersect another one? */
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Box of `radiusM` metres around a position: [west, south, east, north] */
const bboxAround = (lat, lon, radiusM) => {
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
};

/**
 * Datasets that cover the area around a position, finest first.
 * @returns {ShomDataset[]}
 */
const datasetsAround = (lat, lon, radiusM) => {
    const area = bboxAround(lat, lon, radiusM);
    return SHOM_DATASETS
        .filter(d => intersects(d.bbox, area))
        .sort((a, b) => a.resolutionM - b.resolutionM);
};

module.exports = { SHOM_DATASETS, datasetsAround, bboxAround, intersects };
