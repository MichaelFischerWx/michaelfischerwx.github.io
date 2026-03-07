/* ══════════════════════════════════════════════════════════════
   Global TC Archive — Frontend Logic
   TC-RADAR · Dr. Michael Fischer · University of Miami / NOAA HRD
   ══════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ── Configuration ────────────────────────────────────────────
var API_BASE = 'https://tc-radar-api.onrender.com';
var STORMS_JSON = 'ibtracs_storms.json';
var TRACKS_MANIFEST = 'ibtracs_tracks_manifest.json';
var TRACKS_JSON_FALLBACK = 'ibtracs_tracks.json';  // Fallback for single-file mode

// ── State ────────────────────────────────────────────────────
var allStorms = [];          // Full storm metadata array
var allTracks = {};          // SID → track points dict
var filteredStorms = [];     // Currently filtered subset
var selectedStorm = null;    // Currently selected storm object
var stormMap = null;         // Leaflet map (browser tab)
var detailMap = null;        // Leaflet map (detail tab)
var markerCluster = null;    // MarkerClusterGroup
var allMarkerMap = {};       // SID → L.marker (for lookup)
var trackLayer = null;       // L.layerGroup for browser track
var detailTrackLayer = null; // L.layerGroup for detail track
var activeBasins = ['ALL'];  // Active basin filter
var filterDebounce = null;   // Debounce timer

// IR animation state
var irPlaying = false;
var irFrameIdx = 0;
var irFrames = [];           // Cached frame data
var irMeta = null;           // HURSAT metadata
var irTimer = null;
var irSpeed = 750;           // ms per frame
var irOverlayLayer = null;   // L.imageOverlay on detail map
var irPositionMarker = null; // L.circleMarker showing current storm center
var trackAnnotationMarkers = []; // Genesis, LMI, dissipation markers (hidden during IR)
var irOverlayVisible = false;
var irOpacity = 0.8;
var irOpacityLevels = [0.8, 0.6, 0.4, 1.0];
var irOpacityIdx = 0;
var irFailedFrames = {};     // Track frames that permanently failed
var irFollowStorm = true;    // Lock map view to follow storm center
var irFollowZoomSet = false; // True after first fitBounds sets the zoom level

// Climatology state
var climRendered = false;

// ── Basin metadata ───────────────────────────────────────────
var BASIN_NAMES = {
    NA: 'North Atlantic',
    EP: 'East Pacific',
    WP: 'West Pacific',
    NI: 'North Indian',
    SI: 'South Indian',
    SP: 'South Pacific',
    SA: 'South Atlantic'
};

var BASIN_COLORS = {
    NA: '#2e7dff',
    EP: '#00d4ff',
    WP: '#f87171',
    NI: '#fbbf24',
    SI: '#34d399',
    SP: '#a78bfa',
    SA: '#fb923c'
};

// ── Saffir-Simpson helpers ───────────────────────────────────
var SS_COLORS = {
    TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
    C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626',
    UN: '#6b7280'
};

function getIntensityColor(vmax) {
    if (!vmax) return '#6b7280';
    if (vmax < 34) return '#60a5fa';
    if (vmax < 64) return '#34d399';
    if (vmax < 83) return '#fbbf24';
    if (vmax < 96) return '#fb923c';
    if (vmax < 113) return '#f87171';
    if (vmax < 137) return '#ef4444';
    return '#dc2626';
}

function getIntensityCategory(vmax) {
    if (!vmax) return 'Unknown';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'Cat 1';
    if (vmax < 96) return 'Cat 2';
    if (vmax < 113) return 'Cat 3';
    if (vmax < 137) return 'Cat 4';
    return 'Cat 5';
}

function getCatKey(vmax) {
    if (!vmax) return 'UN';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'C1';
    if (vmax < 96) return 'C2';
    if (vmax < 113) return 'C3';
    if (vmax < 137) return 'C4';
    return 'C5';
}

// ── Plotly defaults ──────────────────────────────────────────
var PLOTLY_LAYOUT_BASE = {
    paper_bgcolor: '#0a1628',
    plot_bgcolor: '#0a1628',
    font: { family: 'DM Sans, sans-serif', color: '#e2e8f0' },
    margin: { l: 50, r: 20, t: 10, b: 40 },
    hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12, family: 'DM Sans' } }
};

var PLOTLY_CONFIG = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines']
};

// ══════════════════════════════════════════════════════════════
//  TAB SWITCHING
// ══════════════════════════════════════════════════════════════

window.switchTab = function (tabName) {
    // If switching to detail without a selected storm, redirect through viewStormDetail
    if (tabName === 'detail' && !selectedStorm) {
        showToast('Select a storm first, then click "View Detail"');
        return;
    }

    // Update buttons
    document.querySelectorAll('.ga-tab').forEach(function (btn) {
        var isTarget = btn.getAttribute('data-tab') === tabName;
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });
    // Update panels
    document.querySelectorAll('.ga-tab-content').forEach(function (panel) {
        panel.classList.toggle('active', panel.id === 'tab-' + tabName);
    });
    // Lazy-init
    if (tabName === 'browser' && stormMap) {
        setTimeout(function () { stormMap.invalidateSize(); }, 100);
    }
    if (tabName === 'detail') {
        // If we already have a storm loaded but just switched tabs, re-render
        if (detailMap) {
            setTimeout(function () { detailMap.invalidateSize(); }, 100);
        } else if (selectedStorm) {
            renderStormDetail(selectedStorm);
        }
    }
    if (tabName === 'climatology' && !climRendered && allStorms.length > 0) {
        renderClimatology();
    }
};

// ══════════════════════════════════════════════════════════════
//  DATA LOADING
// ══════════════════════════════════════════════════════════════

function loadData() {
    var loadingEl = document.getElementById('map-loading');

    // Load storms metadata
    fetch(STORMS_JSON)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            allStorms = data.storms || [];
            filteredStorms = allStorms.slice();

            // Update header stats
            var meta = data.metadata || {};
            document.getElementById('stat-storms').textContent = (meta.total_storms || allStorms.length).toLocaleString();
            document.getElementById('stat-years').textContent = meta.year_range ? meta.year_range[0] + '–' + meta.year_range[1] : '';
            document.getElementById('stat-basins').textContent = Object.keys(meta.basin_counts || BASIN_NAMES).length;
            document.getElementById('total-count').textContent = allStorms.length.toLocaleString();
            document.getElementById('filtered-count').textContent = allStorms.length.toLocaleString();

            initBrowserMap();
            renderMarkers(filteredStorms);
            if (loadingEl) loadingEl.style.display = 'none';

            showToast('Loaded ' + allStorms.length.toLocaleString() + ' storms');
        })
        .catch(function (err) {
            console.error('Failed to load storms:', err);
            if (loadingEl) loadingEl.innerHTML = '<span style="color:#f87171;">Failed to load storm data. Check console.</span>';
        });

    // Load track data — try chunked manifest first, fall back to single file
    showToast('Loading track data...');
    fetch(TRACKS_MANIFEST)
        .then(function (r) {
            if (!r.ok) throw new Error('No manifest');
            return r.json();
        })
        .then(function (manifest) {
            // Load chunks in parallel
            var chunks = manifest.chunks || [];
            console.log('Loading ' + chunks.length + ' track chunks...');
            return Promise.all(chunks.map(function (chunkFile) {
                return fetch(chunkFile).then(function (r) { return r.json(); });
            }));
        })
        .then(function (chunkDataArray) {
            // Merge all chunks into allTracks
            chunkDataArray.forEach(function (chunk) {
                Object.keys(chunk).forEach(function (sid) {
                    allTracks[sid] = chunk[sid];
                });
            });
            var n = Object.keys(allTracks).length;
            console.log('Loaded tracks for ' + n + ' storms from chunks');
            showToast('Track data ready — ' + n.toLocaleString() + ' storm tracks');
        })
        .catch(function (manifestErr) {
            // Fallback: try loading single combined file
            console.log('Manifest not found, trying single file...');
            fetch(TRACKS_JSON_FALLBACK)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    allTracks = data;
                    var n = Object.keys(data).length;
                    console.log('Loaded tracks for ' + n + ' storms (single file)');
                    showToast('Track data ready — ' + n.toLocaleString() + ' storm tracks');
                })
                .catch(function (err) {
                    console.warn('Track data not loaded:', err);
                    showToast('Track data failed to load — storm details unavailable');
                });
        });
}

// ══════════════════════════════════════════════════════════════
//  STORM BROWSER TAB
// ══════════════════════════════════════════════════════════════

function initBrowserMap() {
    if (stormMap) return;

    stormMap = L.map('storm-map', {
        center: [20, -20],
        zoom: 2,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(stormMap);

    markerCluster = L.markerClusterGroup({
        maxClusterRadius: 40,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        disableClusteringAtZoom: 8
    });
    stormMap.addLayer(markerCluster);

    trackLayer = L.layerGroup().addTo(stormMap);

    // Add legend
    var legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
        var div = L.DomUtil.create('div', 'ga-legend');
        div.innerHTML = '<h4>Intensity (Saffir-Simpson)</h4>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#60a5fa;"></span> TD (&lt;34 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#34d399;"></span> TS (34–63 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#fbbf24;"></span> Cat 1 (64–82 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#fb923c;"></span> Cat 2 (83–95 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#f87171;"></span> Cat 3 (96–112 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#ef4444;"></span> Cat 4 (113–136 kt)</div>' +
            '<div class="ga-legend-item"><span class="ga-legend-dot" style="background:#dc2626;"></span> Cat 5 (137+ kt)</div>';
        return div;
    };
    legend.addTo(stormMap);
}

function renderMarkers(storms) {
    if (!markerCluster) return;
    markerCluster.clearLayers();
    allMarkerMap = {};
    trackLayer.clearLayers();

    storms.forEach(function (s) {
        if (!s.genesis_lat || !s.genesis_lon) return;

        var color = getIntensityColor(s.peak_wind_kt);
        var icon = L.divIcon({
            className: 'custom-div-icon',
            html: '<div class="custom-marker" style="background-color:' + color + ';width:10px;height:10px;box-shadow:0 0 6px ' + color + '40;"></div>',
            iconSize: [10, 10],
            iconAnchor: [5, 5]
        });

        var marker = L.marker([s.genesis_lat, s.genesis_lon], { icon: icon });
        marker.stormData = s;

        var cat = getIntensityCategory(s.peak_wind_kt);
        var popupHtml =
            '<div style="min-width:180px;">' +
            '<div style="font-weight:700;font-size:14px;margin-bottom:4px;">' + (s.name || 'UNNAMED') +
            ' <span class="intensity-badge" style="background:' + color + ';font-size:10px;padding:1px 6px;">' + cat + '</span></div>' +
            '<div style="font-size:12px;color:#94a3b8;margin-bottom:6px;">' + s.year + ' &middot; ' + (BASIN_NAMES[s.basin] || s.basin) + '</div>' +
            '<div style="font-size:12px;"><b>Peak:</b> ' + (s.peak_wind_kt || '?') + ' kt &middot; ' + (s.min_pres_hpa || '?') + ' hPa</div>' +
            '<div style="font-size:12px;"><b>ACE:</b> ' + (s.ace || 0).toFixed(1) + '</div>' +
            '<div style="margin-top:8px;text-align:center;">' +
            '<button onclick="selectStormFromPopup(\'' + s.sid + '\')" style="background:linear-gradient(135deg,#2e7dff,#00d4ff);color:#fff;border:none;border-radius:4px;padding:4px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:DM Sans,sans-serif;">View Detail</button>' +
            '</div></div>';

        marker.bindPopup(popupHtml, {
            maxWidth: 280,
            minWidth: 200,
            autoPan: true,
            closeButton: true
        });

        marker.on('click', function () {
            selectStorm(s);
        });

        allMarkerMap[s.sid] = marker;
        markerCluster.addLayer(marker);
    });

    document.getElementById('filtered-count').textContent = storms.length.toLocaleString();
}

// ── Storm selection ──────────────────────────────────────────

function selectStorm(storm) {
    selectedStorm = storm;
    var card = document.getElementById('storm-card');
    card.style.display = '';

    var color = getIntensityColor(storm.peak_wind_kt);
    var cat = getIntensityCategory(storm.peak_wind_kt);

    document.getElementById('card-name').textContent = storm.name || 'UNNAMED';
    document.getElementById('card-cat-badge').textContent = cat;
    document.getElementById('card-cat-badge').style.background = color;
    document.getElementById('card-year').textContent = storm.year;
    document.getElementById('card-basin').textContent = BASIN_NAMES[storm.basin] || storm.basin;
    document.getElementById('card-wind').textContent = storm.peak_wind_kt ? storm.peak_wind_kt + ' kt' : 'N/A';
    document.getElementById('card-pres').textContent = storm.min_pres_hpa ? storm.min_pres_hpa + ' hPa' : 'N/A';
    document.getElementById('card-dates').textContent = (storm.start_date || '?') + ' → ' + (storm.end_date || '?');
    document.getElementById('card-ace').textContent = (storm.ace || 0).toFixed(1);

    var hursatEl = document.getElementById('card-hursat');
    if (storm.hursat) {
        hursatEl.innerHTML = '<span style="color:#34d399;">Available (1978–2015)</span>';
    } else {
        hursatEl.innerHTML = '<span style="color:#6b7280;">Not available</span>';
    }

    // Show track on map if available
    showTrackOnBrowserMap(storm.sid);
}

window.selectStormFromPopup = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) {
        selectStorm(storm);
        viewStormDetail();
    }
};

function showTrackOnBrowserMap(sid) {
    if (!trackLayer) return;
    trackLayer.clearLayers();

    var track = allTracks[sid];
    if (!track || track.length < 2) return;

    // Draw track as colored segments
    for (var i = 1; i < track.length; i++) {
        var p0 = track[i - 1];
        var p1 = track[i];
        if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;

        var color = getIntensityColor(p1.w);
        var line = L.polyline(
            [[p0.la, p0.lo], [p1.la, p1.lo]],
            { color: color, weight: 2.5, opacity: 0.85 }
        );
        trackLayer.addLayer(line);
    }

    // Fit bounds
    var lats = track.filter(function (p) { return p.la; }).map(function (p) { return p.la; });
    var lons = track.filter(function (p) { return p.lo; }).map(function (p) { return p.lo; });
    if (lats.length > 0) {
        stormMap.fitBounds([
            [Math.min.apply(null, lats) - 2, Math.min.apply(null, lons) - 2],
            [Math.max.apply(null, lats) + 2, Math.max.apply(null, lons) + 2]
        ]);
    }
}

// ── Filtering ────────────────────────────────────────────────

window.toggleBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');

    if (basin === 'ALL') {
        // Reset all to inactive, set ALL to active
        document.querySelectorAll('.basin-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        activeBasins = ['ALL'];
    } else {
        // Deactivate ALL, toggle this basin
        document.querySelector('.basin-chip[data-basin="ALL"]').classList.remove('active');
        btn.classList.toggle('active');

        activeBasins = [];
        document.querySelectorAll('.basin-chip.active').forEach(function (c) {
            var b = c.getAttribute('data-basin');
            if (b !== 'ALL') activeBasins.push(b);
        });

        // If none selected, revert to ALL
        if (activeBasins.length === 0) {
            document.querySelector('.basin-chip[data-basin="ALL"]').classList.add('active');
            activeBasins = ['ALL'];
        }
    }
    onFilterChange();
};

window.onFilterChange = function () {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(applyFilters, 150);
};

window.onWindFilterChange = function () {
    var val = parseInt(document.getElementById('filter-wind-min').value) || 0;
    var label = document.getElementById('wind-min-label');
    if (val === 0) {
        label.textContent = '0 kt (All)';
    } else {
        label.textContent = val + ' kt (' + getIntensityCategory(val) + '+)';
    }
    onFilterChange();
};

function applyFilters() {
    var nameQuery = (document.getElementById('filter-name').value || '').trim().toUpperCase();
    var yearMin = parseInt(document.getElementById('filter-year-min').value) || 0;
    var yearMax = parseInt(document.getElementById('filter-year-max').value) || 9999;
    var windMin = parseInt(document.getElementById('filter-wind-min').value) || 0;

    filteredStorms = allStorms.filter(function (s) {
        // Name filter
        if (nameQuery && (!s.name || s.name.toUpperCase().indexOf(nameQuery) === -1)) return false;
        // Basin filter
        if (activeBasins[0] !== 'ALL' && activeBasins.indexOf(s.basin) === -1) return false;
        // Year filter
        if (s.year < yearMin || s.year > yearMax) return false;
        // Intensity filter
        if ((s.peak_wind_kt || 0) < windMin) return false;
        return true;
    });

    renderMarkers(filteredStorms);
}

window.resetFilters = function () {
    document.getElementById('filter-name').value = '';
    document.getElementById('filter-year-min').value = '';
    document.getElementById('filter-year-max').value = '';
    document.getElementById('filter-wind-min').value = 0;
    document.getElementById('wind-min-label').textContent = '0 kt (All)';

    document.querySelectorAll('.basin-chip').forEach(function (c) { c.classList.remove('active'); });
    document.querySelector('.basin-chip[data-basin="ALL"]').classList.add('active');
    activeBasins = ['ALL'];

    filteredStorms = allStorms.slice();
    renderMarkers(filteredStorms);

    // Hide storm card
    document.getElementById('storm-card').style.display = 'none';
    selectedStorm = null;
    if (trackLayer) trackLayer.clearLayers();
};

// ══════════════════════════════════════════════════════════════
//  STORM DETAIL TAB
// ══════════════════════════════════════════════════════════════

window.viewStormDetail = function () {
    if (!selectedStorm) {
        showToast('Select a storm first');
        return;
    }

    // Check if tracks are loaded
    if (!allTracks || Object.keys(allTracks).length === 0) {
        showToast('Track data still loading, please wait...');
        // Retry after a short delay
        setTimeout(function () {
            if (selectedStorm) viewStormDetail();
        }, 1500);
        return;
    }

    // Force the tab switch (bypass the guard since we have a storm)
    document.querySelectorAll('.ga-tab').forEach(function (btn) {
        var isTarget = btn.getAttribute('data-tab') === 'detail';
        btn.classList.toggle('active', isTarget);
        btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });
    document.querySelectorAll('.ga-tab-content').forEach(function (panel) {
        panel.classList.toggle('active', panel.id === 'tab-detail');
    });

    // Small delay to let the DOM settle before rendering charts/maps
    setTimeout(function () {
        renderStormDetail(selectedStorm);
    }, 50);
};

function renderStormDetail(storm) {
    // Header
    var color = getIntensityColor(storm.peak_wind_kt);
    var cat = getIntensityCategory(storm.peak_wind_kt);
    document.getElementById('detail-title').innerHTML =
        (storm.name || 'UNNAMED') +
        ' <span class="intensity-badge" style="background:' + color + '">' + cat + '</span>';
    document.getElementById('detail-subtitle').textContent =
        storm.year + ' · ' + (BASIN_NAMES[storm.basin] || storm.basin) +
        ' · Peak: ' + (storm.peak_wind_kt || '?') + ' kt / ' + (storm.min_pres_hpa || '?') + ' hPa' +
        ' · ACE: ' + (storm.ace || 0).toFixed(1);

    // Get track data
    var track = allTracks[storm.sid];
    if (!track || track.length === 0) {
        document.getElementById('timeline-chart').innerHTML = '<div style="padding:40px;text-align:center;color:#8b9ec2;">Track data not available for this storm.</div>';
        return;
    }

    renderIntensityTimeline(track, storm);
    renderDetailMap(track, storm);

    // IR overlay — show toggle for storms with IR data (HURSAT 1978-2015, MergIR 1998+)
    var irToggleWrap = document.getElementById('ir-toggle-wrap');
    var hasIR = storm.hursat || storm.year >= 1998;
    if (hasIR) {
        irToggleWrap.style.display = '';
        document.getElementById('ir-status').textContent = 'Loading...';
        loadHURSAT(storm);
    } else {
        irToggleWrap.style.display = 'none';
        document.getElementById('ir-map-controls').style.display = 'none';
        stopIRPlayback();
        removeIROverlay();
    }
}

function renderIntensityTimeline(track, storm) {
    var times = [];
    var winds = [];
    var pres = [];
    var colors = [];

    track.forEach(function (pt) {
        if (!pt.t) return;
        times.push(pt.t);
        winds.push(pt.w);
        pres.push(pt.p);
        colors.push(getIntensityColor(pt.w));
    });

    // Saffir-Simpson category shading bands
    var shapes = [
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0,   y1: 34,  fillcolor: 'rgba(96,165,250,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 34,  y1: 64,  fillcolor: 'rgba(52,211,153,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 64,  y1: 83,  fillcolor: 'rgba(251,191,36,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 83,  y1: 96,  fillcolor: 'rgba(251,146,60,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 96,  y1: 113, fillcolor: 'rgba(248,113,113,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 113, y1: 137, fillcolor: 'rgba(239,68,68,0.06)', line: { width: 0 } },
        { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 137, y1: 200, fillcolor: 'rgba(220,38,38,0.06)', line: { width: 0 } }
    ];

    var windTrace = {
        x: times,
        y: winds,
        type: 'scatter',
        mode: 'lines+markers',
        name: 'Wind (kt)',
        line: { color: '#00d4ff', width: 2.5 },
        marker: { color: colors, size: 6, line: { color: 'rgba(255,255,255,0.3)', width: 1 } },
        hovertemplate: '<b>%{x}</b><br>Wind: %{y} kt<extra></extra>',
        yaxis: 'y'
    };

    var presTrace = {
        x: times,
        y: pres,
        type: 'scatter',
        mode: 'lines',
        name: 'Pressure (hPa)',
        line: { color: '#a78bfa', width: 1.5, dash: 'dot' },
        hovertemplate: '<b>%{x}</b><br>Pressure: %{y} hPa<extra></extra>',
        yaxis: 'y2'
    };

    var maxWind = Math.max.apply(null, winds.filter(function (w) { return w != null; })) || 100;

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Date/Time', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            linecolor: 'rgba(255,255,255,0.08)'
        },
        yaxis: {
            title: { text: 'Max Wind (kt)', font: { size: 11, color: '#00d4ff' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, Math.min(maxWind + 20, 200)],
            side: 'left'
        },
        yaxis2: {
            title: { text: 'Pressure (hPa)', font: { size: 11, color: '#a78bfa' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            overlaying: 'y',
            side: 'right',
            autorange: 'reversed',
            gridcolor: 'transparent'
        },
        shapes: shapes,
        showlegend: true,
        legend: {
            x: 0.01, y: 0.99,
            bgcolor: 'rgba(15,33,64,0.8)',
            bordercolor: 'rgba(255,255,255,0.08)',
            borderwidth: 1,
            font: { size: 11, color: '#e2e8f0' }
        },
        margin: { l: 55, r: 55, t: 10, b: 45 }
    });

    // Store base shapes for later (IR time marker is appended dynamically)
    window._timelineBaseShapes = shapes.slice();

    Plotly.newPlot('timeline-chart', [windTrace, presTrace], layout, PLOTLY_CONFIG);

    // Click handler to sync IR
    document.getElementById('timeline-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedTime = data.points[0].x;
            syncIRToTime(clickedTime);
        }
    });
}

/**
 * Update the vertical time marker on the intensity chart to match the
 * current IR frame time. Only visible when IR overlay is active.
 * Throttled to avoid expensive Plotly.relayout calls during fast animation.
 */
var _intensityMarkerTimer = null;
var _lastMarkerDt = null;

function updateIntensityMarker(dtStr) {
    // Skip if nothing changed
    if (dtStr === _lastMarkerDt) return;
    _lastMarkerDt = dtStr;

    // Throttle: during animation, delay updates slightly so we don't call
    // Plotly.relayout on every single frame tick (expensive)
    if (_intensityMarkerTimer) clearTimeout(_intensityMarkerTimer);
    _intensityMarkerTimer = setTimeout(function () {
        _applyIntensityMarker(dtStr);
    }, irPlaying ? 200 : 0);  // immediate when paused, 200ms throttle when playing
}

function _applyIntensityMarker(dtStr) {
    var chartEl = document.getElementById('timeline-chart');
    if (!chartEl || !chartEl.layout) return;

    var baseShapes = window._timelineBaseShapes || [];

    if (!dtStr || !irOverlayVisible) {
        // Remove marker — restore base shapes only
        Plotly.relayout(chartEl, { shapes: baseShapes });
        return;
    }

    // Add a vertical line at the IR frame time
    var markerLine = {
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: dtStr,
        x1: dtStr,
        y0: 0,
        y1: 1,
        line: { color: 'rgba(255,200,50,0.7)', width: 2, dash: 'solid' }
    };

    Plotly.relayout(chartEl, { shapes: baseShapes.concat([markerLine]) });
}

function renderDetailMap(track, storm) {
    // Destroy existing map and IR overlay references
    irOverlayLayer = null;
    irPositionMarker = null;
    if (detailMap) {
        detailMap.remove();
        detailMap = null;
    }

    // Create map centered on storm
    var centerLat = storm.lmi_lat || storm.genesis_lat || 20;
    var centerLon = storm.lmi_lon || storm.genesis_lon || -60;

    detailMap = L.map('detail-map', {
        center: [centerLat, centerLon],
        zoom: 4,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(detailMap);

    // Draw track
    for (var i = 1; i < track.length; i++) {
        var p0 = track[i - 1];
        var p1 = track[i];
        if (!p0.la || !p0.lo || !p1.la || !p1.lo) continue;

        var color = getIntensityColor(p1.w);
        L.polyline(
            [[p0.la, p0.lo], [p1.la, p1.lo]],
            { color: color, weight: 3.5, opacity: 0.9 }
        ).addTo(detailMap);
    }

    // Add markers at key points
    var validPts = track.filter(function (p) { return p.la && p.lo; });
    if (validPts.length > 0) {
        // Genesis marker
        trackAnnotationMarkers = [];
        var gen = validPts[0];
        var genM = L.circleMarker([gen.la, gen.lo], {
            radius: 6, color: '#fff', fillColor: '#60a5fa', fillOpacity: 1, weight: 2
        }).bindTooltip('Genesis: ' + (gen.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
        trackAnnotationMarkers.push(genM);

        // LMI marker
        var lmiPt = validPts.reduce(function (max, p) { return (p.w || 0) > (max.w || 0) ? p : max; }, validPts[0]);
        if (lmiPt) {
            var lmiM = L.circleMarker([lmiPt.la, lmiPt.lo], {
                radius: 8, color: '#fff', fillColor: getIntensityColor(lmiPt.w), fillOpacity: 1, weight: 2
            }).bindTooltip('Peak: ' + (lmiPt.w || '?') + ' kt @ ' + (lmiPt.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
            trackAnnotationMarkers.push(lmiM);
        }

        // End marker
        var end = validPts[validPts.length - 1];
        var endM = L.circleMarker([end.la, end.lo], {
            radius: 5, color: '#fff', fillColor: '#6b7280', fillOpacity: 1, weight: 2
        }).bindTooltip('Dissipation: ' + (end.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
        trackAnnotationMarkers.push(endM);

        // Fit bounds
        var lats = validPts.map(function (p) { return p.la; });
        var lons = validPts.map(function (p) { return p.lo; });
        detailMap.fitBounds([
            [Math.min.apply(null, lats) - 3, Math.min.apply(null, lons) - 5],
            [Math.max.apply(null, lats) + 3, Math.max.apply(null, lons) + 5]
        ]);
    }
}

// ══════════════════════════════════════════════════════════════
//  HURSAT IR ANIMATION
// ══════════════════════════════════════════════════════════════

function loadHURSAT(storm) {
    irFrames = [];
    irMeta = null;
    irFrameIdx = 0;
    irPrefetchActive = 0;
    irFailedFrames = {};
    irFollowZoomSet = false;
    stopIRPlayback();
    removeIROverlay();

    // Build track data for MergIR (needed for storm-centered subsetting)
    var track = allTracks[storm.sid] || [];
    var trackParam = track.length > 0 ? '&track=' + encodeURIComponent(JSON.stringify(track)) : '';

    // Pass storm longitude for satellite viewing angle selection (HURSAT dedup)
    var lonParam = storm.lmi_lon != null ? '&storm_lon=' + storm.lmi_lon : '';

    // Use unified IR endpoint (auto-selects HURSAT vs MergIR)
    var metaUrl = API_BASE + '/global/ir/meta?sid=' + encodeURIComponent(storm.sid) + trackParam + lonParam;

    // Fall back to HURSAT-only endpoint if unified fails
    var fallbackUrl = API_BASE + '/global/hursat/meta?sid=' + encodeURIComponent(storm.sid) + lonParam;

    document.getElementById('ir-status').textContent = 'Checking satellite data...';

    fetch(metaUrl)
        .then(function (r) {
            if (!r.ok) throw new Error('IR metadata not available');
            return r.json();
        })
        .catch(function () {
            return fetch(fallbackUrl).then(function (r) {
                if (!r.ok) throw new Error('HURSAT metadata not available');
                return r.json();
            });
        })
        .then(function (meta) {
            if (!meta.available || meta.n_frames === 0) {
                var reason = meta.reason || 'No satellite frames found';
                document.getElementById('ir-status').textContent = reason;
                document.getElementById('ir-toggle-wrap').style.display = 'none';
                return;
            }
            irMeta = meta;
            document.getElementById('ir-slider').max = meta.n_frames - 1;
            document.getElementById('ir-slider').value = 0;

            var sourceLabel = meta.source === 'mergir' ? 'MergIR 4km' : (meta.source === 'gridsat' ? 'GridSat-B1' : 'HURSAT-B1');
            document.getElementById('ir-status').textContent =
                meta.n_frames + ' frames (' + sourceLabel + ')';
            document.getElementById('ir-source-badge').textContent = sourceLabel;

            // Auto-show IR overlay
            irOverlayVisible = true;
            // Hide genesis/LMI/dissipation markers so they don't obscure IR
            trackAnnotationMarkers.forEach(function (m) { if (detailMap) detailMap.removeLayer(m); });
            var toggleBtn = document.getElementById('ir-toggle-btn');
            toggleBtn.textContent = 'Hide IR';
            toggleBtn.classList.add('active');
            document.getElementById('ir-map-controls').style.display = '';

            // Show loading state for first frame
            var loadingEl = document.getElementById('ir-frame-loading');
            if (loadingEl) loadingEl.style.display = 'flex';
            if (meta.source === 'hursat') {
                setIRLoadingText('Downloading satellite archive...\nThis may take up to 60 seconds');
            } else {
                setIRLoadingText('Loading satellite imagery...');
            }

            // Load first frame — this triggers the tarball download on the server
            irFrameIdx = 0;
            loadIRFrame(0);

            // Don't start prefetching until the first frame succeeds
            // (prefetch is triggered by loadIRFrame's callback)
        })
        .catch(function (err) {
            console.warn('IR load failed:', err);
            document.getElementById('ir-status').textContent = 'API not connected';
            document.getElementById('ir-toggle-wrap').style.display = 'none';
        });
}

function removeIROverlay() {
    if (irOverlayLayer && detailMap) {
        try { detailMap.removeLayer(irOverlayLayer); } catch (e) {}
    }
    irOverlayLayer = null;
    if (irPositionMarker && detailMap) {
        try { detailMap.removeLayer(irPositionMarker); } catch (e) {}
    }
    // Clear intensity chart marker
    _lastMarkerDt = null;
    if (typeof updateIntensityMarker === 'function') {
        updateIntensityMarker(null);
    }
    irPositionMarker = null;
    irOverlayVisible = false;
}

window.toggleIROverlay = function () {
    if (!irMeta) return;
    irOverlayVisible = !irOverlayVisible;

    var toggleBtn = document.getElementById('ir-toggle-btn');
    var controls = document.getElementById('ir-map-controls');

    if (irOverlayVisible) {
        toggleBtn.textContent = 'Hide IR';
        toggleBtn.classList.add('active');
        controls.style.display = '';
        // Hide track annotation markers so they don't obscure IR
        trackAnnotationMarkers.forEach(function (m) { if (detailMap) detailMap.removeLayer(m); });
        if (irOverlayLayer && detailMap) {
            irOverlayLayer.addTo(detailMap);
            irOverlayLayer.setOpacity(irOpacity);
        }
        if (irPositionMarker && detailMap) {
            irPositionMarker.addTo(detailMap);
        }
        if (irFrames[irFrameIdx]) {
            displayIROnMap(irFrames[irFrameIdx]);
        } else {
            loadIRFrame(irFrameIdx);
        }
    } else {
        toggleBtn.textContent = 'Show IR';
        toggleBtn.classList.remove('active');
        controls.style.display = 'none';
        stopIRPlayback();
        if (irOverlayLayer && detailMap) {
            detailMap.removeLayer(irOverlayLayer);
        }
        if (irPositionMarker && detailMap) {
            detailMap.removeLayer(irPositionMarker);
        }
        // Restore track annotation markers
        trackAnnotationMarkers.forEach(function (m) { if (detailMap) m.addTo(detailMap); });
        // Remove intensity chart time marker
        updateIntensityMarker(null);
    }
};

window.cycleIROpacity = function () {
    irOpacityIdx = (irOpacityIdx + 1) % irOpacityLevels.length;
    irOpacity = irOpacityLevels[irOpacityIdx];
    document.getElementById('ir-opacity-label').textContent = Math.round(irOpacity * 100) + '%';
    if (irOverlayLayer) {
        irOverlayLayer.setOpacity(irOpacity);
    }
};

window.toggleIRFollow = function () {
    irFollowStorm = !irFollowStorm;
    irFollowZoomSet = false; // Reset so next frame establishes zoom
    var btn = document.getElementById('ir-follow-btn');
    if (btn) {
        btn.classList.toggle('active', irFollowStorm);
        btn.title = irFollowStorm ? 'View locked to storm center (click to unlock)' : 'Free pan mode (click to lock on storm)';
    }
    // If just enabled, immediately snap to current frame
    if (irFollowStorm && irOverlayLayer && detailMap) {
        var frameBounds = irOverlayLayer.getBounds();
        if (frameBounds) {
            detailMap.fitBounds(frameBounds.pad(0.15), { animate: true, duration: 0.3, maxZoom: 7 });
            irFollowZoomSet = true;
        }
    }
};

function displayIROnMap(data) {
    if (!detailMap || !irOverlayVisible) {
        console.log('displayIROnMap: skipped (map=' + !!detailMap + ', visible=' + irOverlayVisible + ')');
        return;
    }
    if (!data || !data.frame) {
        console.warn('displayIROnMap: no frame data', data);
        return;
    }
    console.log('displayIROnMap: rendering frame, bounds=', data.bounds, 'frame length=', data.frame.length);

    var bounds = data.bounds;
    if (!bounds) {
        // Fallback: estimate bounds from storm position
        var track = allTracks[selectedStorm.sid] || [];
        var frameMeta = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
        var centerLat, centerLon;
        if (frameMeta && frameMeta.lat != null) {
            centerLat = frameMeta.lat;
            centerLon = frameMeta.lon;
        } else if (frameMeta && frameMeta.datetime) {
            var pt = findTrackPointAtTime(track, frameMeta.datetime);
            centerLat = pt ? pt.la : (selectedStorm.lmi_lat || 20);
            centerLon = pt ? pt.lo : (selectedStorm.lmi_lon || -60);
        } else {
            centerLat = selectedStorm.lmi_lat || 20;
            centerLon = selectedStorm.lmi_lon || -60;
        }
        var halfDeg = (data.source === 'mergir' || data.source === 'gridsat') ? 5.0 : 6.0;
        bounds = {
            south: centerLat - halfDeg,
            north: centerLat + halfDeg,
            west: centerLon - halfDeg,
            east: centerLon + halfDeg
        };
    }

    var imageBounds = L.latLngBounds(
        [bounds.south, bounds.west],
        [bounds.north, bounds.east]
    );

    // Remove old overlay and create fresh one each frame
    // (setUrl + setBounds on data URIs can cause stale image rendering)
    if (irOverlayLayer) {
        try { detailMap.removeLayer(irOverlayLayer); } catch (e) {}
    }
    irOverlayLayer = L.imageOverlay(data.frame, imageBounds, {
        opacity: irOpacity,
        interactive: false,
        className: 'ir-overlay-image'
    }).addTo(detailMap);

    // Pan/zoom map based on follow mode
    if (irFollowStorm) {
        if (!irFollowZoomSet) {
            // First frame: fitBounds to establish correct zoom level
            var padded = imageBounds.pad(0.15);
            detailMap.fitBounds(padded, {
                animate: false,
                maxZoom: 7
            });
            irFollowZoomSet = true;
        } else {
            // Subsequent frames: panTo center at existing zoom (no zoom jitter)
            var center = imageBounds.getCenter();
            detailMap.panTo(center, {
                animate: irPlaying,
                duration: irPlaying ? 0.3 : 0
            });
        }
    } else if (!detailMap.getBounds().contains(imageBounds)) {
        // Free-pan mode: only refit when IR drifts off-screen
        var padded = imageBounds.pad(0.3);
        detailMap.fitBounds(padded, { animate: true, duration: 0.4, maxZoom: 7 });
    }

    // Update storm position marker
    updateIRPositionMarker(data);
}

function updateIRPositionMarker(data) {
    if (!detailMap) return;

    var frameMeta = irMeta && irMeta.frames ? irMeta.frames[irFrameIdx] : null;
    var lat, lon;

    if (frameMeta && frameMeta.lat != null) {
        lat = frameMeta.lat;
        lon = frameMeta.lon;
    } else if (frameMeta && frameMeta.datetime) {
        var track = allTracks[selectedStorm.sid] || [];
        var pt = findTrackPointAtTime(track, frameMeta.datetime);
        if (pt) { lat = pt.la; lon = pt.lo; }
    }

    if (lat != null && lon != null) {
        if (irPositionMarker) {
            irPositionMarker.setLatLng([lat, lon]);
        } else {
            irPositionMarker = L.circleMarker([lat, lon], {
                radius: 4,
                color: 'rgba(255,255,255,0.85)',
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 1.5,
                pane: 'markerPane'
            }).addTo(detailMap);
            irPositionMarker.bindTooltip('', { className: 'track-tooltip', permanent: false });
        }
        var tipText = (frameMeta.datetime || '');
        if (data && data.satellite) tipText += ' [' + data.satellite + ']';
        irPositionMarker.setTooltipContent(tipText);
    }
}

function findTrackPointAtTime(track, dtStr) {
    if (!track || !track.length || !dtStr) return null;
    var targetMs = new Date(dtStr).getTime();

    // Find the two flanking track points for interpolation
    var before = null, after = null;
    var beforeMs = -Infinity, afterMs = Infinity;

    for (var i = 0; i < track.length; i++) {
        if (!track[i].t || !track[i].la) continue;
        var ptMs = new Date(track[i].t).getTime();

        if (ptMs <= targetMs && ptMs > beforeMs) {
            before = track[i];
            beforeMs = ptMs;
        }
        if (ptMs >= targetMs && ptMs < afterMs) {
            after = track[i];
            afterMs = ptMs;
        }
    }

    // Exact match or only one side available
    if (!before && !after) return null;
    if (!before) return after;
    if (!after) return before;
    if (beforeMs === afterMs) return before;

    // Linear interpolation between flanking points
    var frac = (targetMs - beforeMs) / (afterMs - beforeMs);
    return {
        t: dtStr,
        la: before.la + frac * (after.la - before.la),
        lo: before.lo + frac * (after.lo - before.lo),
        w: before.w != null && after.w != null
            ? Math.round(before.w + frac * (after.w - before.w))
            : (before.w || after.w),
        p: before.p != null && after.p != null
            ? Math.round(before.p + frac * (after.p - before.p))
            : (before.p || after.p)
    };
}

function updateIRCacheStatus() {
    if (!irMeta) return;
    var cached = irFrames.filter(function (f) { return f; }).length;
    var total = irMeta.n_frames;
    var sourceLabel = irMeta.source === 'mergir' ? 'MergIR 4km' : (irMeta.source === 'gridsat' ? 'GridSat-B1' : 'HURSAT-B1');
    var statusEl = document.getElementById('ir-status');
    if (cached < total) {
        statusEl.textContent = cached + ' / ' + total + ' frames loaded (' + sourceLabel + ')';
    } else {
        statusEl.textContent = total + ' frames (' + sourceLabel + ')';
    }
}

var irPrefetchQueue = [];    // Frames queued for prefetch
var irPrefetchActive = 0;    // Number of active prefetch requests
var IR_PREFETCH_BATCH = 5;        // Concurrent prefetch requests (HURSAT)
var IR_PREFETCH_BATCH_GRIDSAT = 8; // Higher concurrency for GridSat (small subsets, no auth)
var IR_PREFETCH_BATCH_MERGIR = 6;  // MergIR (Earthdata auth, 4km subsets)
var IR_PREFETCH_AHEAD = 15;  // How many frames ahead to prefetch

function setIRLoadingText(msg) {
    var el = document.getElementById('ir-loading-text');
    if (el) el.textContent = msg;
}

function loadIRFrame(idx) {
    if (!irMeta || !selectedStorm) return;

    var loadingEl = document.getElementById('ir-frame-loading');

    // Check cache
    if (irFrames[idx]) {
        displayIROnMap(irFrames[idx]);
        updateIRMeta(idx);
        if (loadingEl) loadingEl.style.display = 'none';
        prefetchIRFrames(idx);
        return;
    }

    if (loadingEl) loadingEl.style.display = 'flex';

    // Show context-specific loading message
    var cached = Object.keys(irFrames).length;
    var source = irMeta.source || 'hursat';
    if (cached === 0 && source === 'hursat') {
        setIRLoadingText('Downloading satellite archive...\nThis may take up to 60 seconds');
    } else if (cached === 0) {
        setIRLoadingText('Loading satellite imagery...');
    } else {
        setIRLoadingText('Loading frame ' + (idx + 1) + '...');
    }

    fetchIRFrameSingle(idx, function (data) {
        if (data && irFrameIdx === idx) {
            displayIROnMap(data);
        }
        if (!data && irFrameIdx === idx) {
            irFailedFrames[idx] = true;
            // During playback, auto-skip to next frame
            if (irPlaying && irMeta) {
                var nextIdx = (idx + 1) % irMeta.n_frames;
                // Prevent infinite loop if all frames failed
                var attempts = 0;
                while (irFailedFrames[nextIdx] && attempts < irMeta.n_frames) {
                    nextIdx = (nextIdx + 1) % irMeta.n_frames;
                    attempts++;
                }
                if (attempts < irMeta.n_frames) {
                    irFrameIdx = nextIdx;
                    if (loadingEl) loadingEl.style.display = 'none';
                    loadIRFrame(nextIdx);
                    return;
                }
            }
            setIRLoadingText('Frame ' + (idx + 1) + ' unavailable');
            setTimeout(function () {
                if (loadingEl) loadingEl.style.display = 'none';
            }, 1500);
            return;
        }
        updateIRMeta(idx);
        if (loadingEl) loadingEl.style.display = 'none';
        prefetchIRFrames(idx);
    });
}

function fetchIRFrameSingle(idx, callback) {
    if (!irMeta || !selectedStorm) return;
    if (irFrames[idx]) { callback(irFrames[idx]); return; }

    // Build URL based on source (MergIR needs lat/lon, use unified endpoint)
    var frameUrl;
    var source = irMeta.source || 'hursat';

    if ((source === 'mergir' || source === 'gridsat') && irMeta.frames && irMeta.frames[idx]) {
        var fi = irMeta.frames[idx];
        frameUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(selectedStorm.sid) +
            '&frame_idx=' + idx +
            '&lat=' + fi.lat + '&lon=' + fi.lon;
    } else {
        // HURSAT: use legacy endpoint directly (most reliable)
        frameUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(selectedStorm.sid) +
            '&frame_idx=' + idx;
    }

    // Use longer timeout for first frame (tarball download can take 60-120s)
    var cached = Object.keys(irFrames).length;
    var timeoutMs = cached === 0 ? 180000 : 60000;  // 3 min first, 1 min after
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

    fetch(frameUrl, { signal: controller.signal })
        .then(function (r) {
            clearTimeout(timer);
            if (!r.ok) throw new Error('Frame not available (HTTP ' + r.status + ')');
            return r.json();
        })
        .then(function (data) {
            irFrames[idx] = data;
            updateIRCacheStatus();
            if (callback) callback(data);
        })
        .catch(function (err) {
            clearTimeout(timer);
            console.warn('Frame ' + idx + ' load failed from ' + source + ':', err);
            // Fallback: try the other endpoint
            var fallbackUrl;
            if (source === 'hursat') {
                fallbackUrl = API_BASE + '/global/ir/frame?sid=' + encodeURIComponent(selectedStorm.sid) + '&frame_idx=' + idx;
            } else {
                // For mergir/gridsat, fall back to HURSAT legacy endpoint
                fallbackUrl = API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(selectedStorm.sid) + '&frame_idx=' + idx;
            }
            fetch(fallbackUrl)
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (data) {
                        irFrames[idx] = data;
                        updateIRCacheStatus();
                    }
                    if (callback) callback(data);
                })
                .catch(function () { if (callback) callback(null); });
        });
}

function prefetchIRFrames(currentIdx) {
    if (!irMeta) return;
    var total = irMeta.n_frames;
    var source = irMeta.source || 'hursat';

    // All sources use parallel individual fetches with self-replenishing chains.
    // Each completed fetch triggers another prefetchIRFrames() call, keeping
    // all slots filled until every frame is cached.
    var maxConcurrent;
    if (source === 'gridsat') maxConcurrent = IR_PREFETCH_BATCH_GRIDSAT;
    else if (source === 'mergir') maxConcurrent = IR_PREFETCH_BATCH_MERGIR;
    else maxConcurrent = IR_PREFETCH_BATCH;

    if (irPrefetchActive >= maxConcurrent) return;

    // Scan forward from current display position, wrapping around the full
    // loop, to find uncached frames. Always prioritizes frames the user
    // is about to see. No frontier needed — the scan itself skips cached frames.
    var toFetch = [];
    var slots = maxConcurrent - irPrefetchActive;
    for (var i = 0; i < total && toFetch.length < slots; i++) {
        var idx = (currentIdx + 1 + i) % total;
        if (!irFrames[idx] && !irFailedFrames[idx]) {
            toFetch.push(idx);
        }
    }

    // Also prefetch a few behind current display (for rewinding)
    for (var j = 1; j <= 3; j++) {
        var prevIdx = (currentIdx - j + total) % total;
        if (!irFrames[prevIdx] && !irFailedFrames[prevIdx] &&
            toFetch.indexOf(prevIdx) === -1 && toFetch.length < slots + 3) {
            toFetch.push(prevIdx);
        }
    }

    if (toFetch.length === 0) return;

    // Fire individual fetches in parallel — self-replenishing chain
    toFetch.forEach(function (idx) {
        irPrefetchActive++;
        fetchIRFrameSingle(idx, function (data) {
            irPrefetchActive--;
            updateIRCacheStatus();
            // Chain: each completion immediately fills the empty slot
            prefetchIRFrames(irFrameIdx);
        });
    });
}

/* fetchIRBatch removed — all sources now use individual parallel fetches via prefetchIRFrames */

function updateIRMeta(idx) {
    var datetimeEl = document.getElementById('ir-datetime');
    var frameInfoEl = document.getElementById('ir-frame-info');

    var dtText = '';
    if (irMeta && irMeta.frames && irMeta.frames[idx]) {
        dtText = irMeta.frames[idx].datetime || '';
        var sat = irMeta.frames[idx].satellite || '';
        if (datetimeEl) datetimeEl.textContent = dtText + (sat ? '  [' + sat + ']' : '');
        // Log NC file for HURSAT debugging
        var frameData = irFrames[idx];
        if (frameData && frameData.nc_file) {
            console.log('Frame ' + idx + ': ' + dtText + ' → ' + frameData.nc_file);
        }
    }
    if (frameInfoEl) {
        frameInfoEl.textContent = 'Frame ' + (idx + 1) + ' / ' + (irMeta ? irMeta.n_frames : '?');
    }
    var slider = document.getElementById('ir-slider');
    if (slider) slider.value = idx;

    // Sync intensity chart marker to current IR time
    updateIntensityMarker(dtText);

    // Update cache status
    updateIRCacheStatus();
}

window.toggleIRPlay = function () {
    if (irPlaying) {
        stopIRPlayback();
    } else {
        startIRPlayback();
    }
};

function startIRPlayback() {
    if (!irMeta || irMeta.n_frames === 0) return;
    irPlaying = true;
    document.getElementById('ir-play-btn').innerHTML = '&#9646;&#9646; Pause';

    irTimer = setInterval(function () {
        var nextIdx = (irFrameIdx + 1) % irMeta.n_frames;

        // If next frame isn't cached and isn't a known failure, loop back to
        // the earliest cached frame so the user never sees a loading spinner.
        if (!irFrames[nextIdx] && !irFailedFrames[nextIdx]) {
            // Find the first cached frame at or after index 0
            var loopIdx = -1;
            for (var i = 0; i < irMeta.n_frames; i++) {
                if (irFrames[i]) { loopIdx = i; break; }
            }
            if (loopIdx >= 0 && loopIdx !== irFrameIdx) {
                irFrameIdx = loopIdx;
                displayIROnMap(irFrames[loopIdx]);
                updateIRMeta(loopIdx);
                // Continue prefetching ahead of where we stopped
                prefetchIRFrames(nextIdx);
                return;
            }
        }

        irFrameIdx = nextIdx;
        loadIRFrame(irFrameIdx);
    }, irSpeed);
}

function stopIRPlayback() {
    irPlaying = false;
    if (irTimer) clearInterval(irTimer);
    irTimer = null;
    var btn = document.getElementById('ir-play-btn');
    if (btn) btn.innerHTML = '&#9654; Play';
}

window.seekIRFrame = function (val) {
    irFrameIdx = parseInt(val);
    loadIRFrame(irFrameIdx);
};

window.setIRSpeed = function (val) {
    irSpeed = parseInt(val);
    if (irPlaying) {
        stopIRPlayback();
        startIRPlayback();
    }
};

function syncIRToTime(clickedTime) {
    if (!irMeta || !irMeta.frames) return;

    // Find nearest frame to clicked time
    var targetMs = new Date(clickedTime).getTime();
    var bestIdx = 0;
    var bestDiff = Infinity;

    irMeta.frames.forEach(function (f, idx) {
        var diff = Math.abs(new Date(f.datetime).getTime() - targetMs);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = idx;
        }
    });

    irFrameIdx = bestIdx;
    loadIRFrame(bestIdx);
}

// ══════════════════════════════════════════════════════════════
//  CLIMATOLOGY TAB
// ══════════════════════════════════════════════════════════════

function renderClimatology() {
    if (allStorms.length === 0) return;
    climRendered = true;

    // Year range
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.min.apply(null, years);
    var maxYear = Math.max.apply(null, years);
    document.getElementById('clim-year-range').textContent = minYear + '–' + maxYear;

    renderACEChart(minYear, maxYear);
    renderFrequencyChart(minYear, maxYear);
    renderIntensityHistogram();
    renderBasinPie();
}

function renderACEChart(minYear, maxYear) {
    // Compute ACE by year and basin
    var basins = Object.keys(BASIN_NAMES);
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = basins.map(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        return {
            x: yearRange,
            y: aceByYear,
            type: 'bar',
            name: basin,
            marker: { color: BASIN_COLORS[basin] || '#6b7280' },
            hovertemplate: '<b>' + basin + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 55, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-ace-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler: open ACE drill-down modal
    document.getElementById('clim-ace-chart').on('plotly_click', function () {
        openACEModal();
    });
}

function renderFrequencyChart(minYear, maxYear) {
    var catOrder = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'];
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = catOrder.map(function (cat) {
        var countsByYear = yearRange.map(function (yr) {
            return allStorms.filter(function (s) {
                return s.year === yr && getCatKey(s.peak_wind_kt) === cat;
            }).length;
        });

        return {
            x: yearRange,
            y: countsByYear,
            type: 'bar',
            name: cat,
            marker: { color: SS_COLORS[cat] },
            hovertemplate: '<b>%{x}</b><br>' + cat + ': %{y}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'Storm Count', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 50, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-freq-chart', traces, layout, PLOTLY_CONFIG);
}

function renderIntensityHistogram() {
    var winds = allStorms
        .map(function (s) { return s.peak_wind_kt; })
        .filter(function (w) { return w != null && w > 0; });

    // Color bins by Saffir-Simpson
    var binEdges = [0, 34, 64, 83, 96, 113, 137, 200];
    var binColors = ['#60a5fa', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#ef4444', '#dc2626'];
    var binLabels = ['TD', 'TS', 'Cat 1', 'Cat 2', 'Cat 3', 'Cat 4', 'Cat 5'];

    var traces = [];
    for (var i = 0; i < binEdges.length - 1; i++) {
        var lo = binEdges[i];
        var hi = binEdges[i + 1];
        var binWinds = winds.filter(function (w) { return w >= lo && w < hi; });
        traces.push({
            x: binWinds,
            type: 'histogram',
            name: binLabels[i],
            marker: { color: binColors[i] },
            xbins: { start: lo, end: hi, size: 5 },
            hovertemplate: binLabels[i] + '<br>%{x} kt: %{y} storms<extra></extra>'
        });
    }

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Peak Wind Speed (kt)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)',
            range: [0, 200]
        },
        yaxis: {
            title: { text: 'Number of Storms', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 50, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-hist-chart', traces, layout, PLOTLY_CONFIG);
}

function renderBasinPie() {
    var basinCounts = {};
    allStorms.forEach(function (s) {
        var b = s.basin || 'UN';
        basinCounts[b] = (basinCounts[b] || 0) + 1;
    });

    var labels = [];
    var values = [];
    var colors = [];
    Object.keys(BASIN_NAMES).forEach(function (b) {
        if (basinCounts[b]) {
            labels.push(BASIN_NAMES[b] + ' (' + b + ')');
            values.push(basinCounts[b]);
            colors.push(BASIN_COLORS[b] || '#6b7280');
        }
    });

    var trace = {
        labels: labels,
        values: values,
        type: 'pie',
        hole: 0.45,
        marker: { colors: colors, line: { color: '#0a1628', width: 2 } },
        textfont: { color: '#e2e8f0', size: 11, family: 'DM Sans' },
        textinfo: 'label+percent',
        textposition: 'outside',
        hovertemplate: '<b>%{label}</b><br>%{value} storms (%{percent})<extra></extra>'
    };

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        showlegend: false,
        margin: { l: 20, r: 20, t: 10, b: 10 }
    });

    Plotly.newPlot('clim-basin-chart', [trace], layout, PLOTLY_CONFIG);
}

// ══════════════════════════════════════════════════════════════
//  ACE DRILL-DOWN MODAL
// ══════════════════════════════════════════════════════════════

var aceModalBasins = ['ALL'];   // Active basins in ACE modal

window.openACEModal = function () {
    var modal = document.getElementById('ace-modal');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Reset basin chips
    aceModalBasins = ['ALL'];
    document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-basin') === 'ALL');
    });

    // Hide year detail initially
    document.getElementById('ace-year-detail').style.display = 'none';

    renderACEDrillDownChart();
};

window.closeACEModal = function () {
    document.getElementById('ace-modal').style.display = 'none';
    document.body.style.overflow = '';
};

window.toggleACEBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');

    if (basin === 'ALL') {
        document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        aceModalBasins = ['ALL'];
    } else {
        document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.remove('active');
        btn.classList.toggle('active');

        aceModalBasins = [];
        document.querySelectorAll('#ace-basin-chips .basin-chip.active').forEach(function (c) {
            var b = c.getAttribute('data-basin');
            if (b !== 'ALL') aceModalBasins.push(b);
        });
        if (aceModalBasins.length === 0) {
            document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.add('active');
            aceModalBasins = ['ALL'];
        }
    }

    renderACEDrillDownChart();
    document.getElementById('ace-year-detail').style.display = 'none';
};

function renderACEDrillDownChart() {
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.max(Math.min.apply(null, years), 1950);
    var maxYear = Math.max.apply(null, years);
    var yearRange = [];
    for (var y = minYear; y <= maxYear; y++) yearRange.push(y);

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;
    var traces = [];

    basins.forEach(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        traces.push({
            x: yearRange,
            y: aceByYear,
            type: 'scatter',
            mode: 'lines',
            name: BASIN_NAMES[basin] || basin,
            line: { color: BASIN_COLORS[basin] || '#6b7280', width: 2 },
            hovertemplate: '<b>' + (BASIN_NAMES[basin] || basin) + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        });
    });

    // Also add total ACE as a thicker dashed line if showing all basins
    if (aceModalBasins[0] === 'ALL') {
        var totalACE = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });
        traces.push({
            x: yearRange,
            y: totalACE,
            type: 'scatter',
            mode: 'lines',
            name: 'Global Total',
            line: { color: '#e2e8f0', width: 2.5, dash: 'dot' },
            hovertemplate: '<b>Global %{x}</b><br>Total ACE: %{y:.1f}<extra></extra>'
        });
    }

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.15,
            font: { size: 10, color: '#8b9ec2' }
        },
        margin: { l: 55, r: 10, t: 35, b: 45 },
        hovermode: 'x unified'
    });

    Plotly.newPlot('ace-drilldown-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler for year drill-down
    var chartEl = document.getElementById('ace-drilldown-chart');
    chartEl.removeAllListeners && chartEl.removeAllListeners('plotly_click');
    chartEl.on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedYear = data.points[0].x;
            renderACEYearDetail(clickedYear);
        }
    });
}

function renderACEYearDetail(year) {
    var detailDiv = document.getElementById('ace-year-detail');
    detailDiv.style.display = '';

    // Scroll to it
    detailDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;

    // Get storms for this year matching basin filter
    var yearStorms = allStorms.filter(function (s) {
        return s.year === year && (aceModalBasins[0] === 'ALL' || aceModalBasins.indexOf(s.basin) !== -1);
    });

    // Sort by ACE descending
    yearStorms.sort(function (a, b) { return (b.ace || 0) - (a.ace || 0); });

    var totalACE = yearStorms.reduce(function (sum, s) { return sum + (s.ace || 0); }, 0);

    document.getElementById('ace-year-title').textContent =
        year + ' Season — ' + yearStorms.length + ' storms, ACE: ' + totalACE.toFixed(1);

    // Bar chart of storm ACE
    var stormNames = yearStorms.map(function (s) {
        return (s.name || 'UNNAMED') + ' (' + s.basin + ')';
    });
    var stormACE = yearStorms.map(function (s) { return Math.round((s.ace || 0) * 10) / 10; });
    var stormColors = yearStorms.map(function (s) { return getIntensityColor(s.peak_wind_kt); });

    var trace = {
        y: stormNames,
        x: stormACE,
        type: 'bar',
        orientation: 'h',
        marker: { color: stormColors },
        hovertemplate: '<b>%{y}</b><br>ACE: %{x:.1f}<extra></extra>',
        texttemplate: '%{x:.1f}',
        textposition: 'outside',
        textfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }
    };

    var chartHeight = Math.max(250, yearStorms.length * 26 + 60);

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        yaxis: {
            tickfont: { size: 10, color: '#e2e8f0' },
            autorange: 'reversed'
        },
        showlegend: false,
        margin: { l: 160, r: 50, t: 10, b: 40 },
        height: chartHeight
    });

    Plotly.newPlot('ace-year-chart', [trace], layout, PLOTLY_CONFIG);

    // Click handler to jump to storm detail
    document.getElementById('ace-year-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var idx = data.points[0].pointIndex;
            var storm = yearStorms[idx];
            if (storm) {
                closeACEModal();
                selectedStorm = storm;
                selectStorm(storm);
                viewStormDetail();
            }
        }
    });

    // Build table
    var maxACE = Math.max.apply(null, stormACE) || 1;
    var html = '<table><thead><tr>' +
        '<th>Storm</th><th>Basin</th><th>Peak Wind</th><th>Min Pres</th><th>ACE</th><th style="width:30%;">Contribution</th>' +
        '</tr></thead><tbody>';

    yearStorms.forEach(function (s) {
        var pct = totalACE > 0 ? ((s.ace || 0) / totalACE * 100) : 0;
        var barWidth = maxACE > 0 ? ((s.ace || 0) / maxACE * 100) : 0;
        var color = getIntensityColor(s.peak_wind_kt);
        html += '<tr>' +
            '<td><span class="ace-storm-name" style="color:' + color + ';" onclick="aceJumpToStorm(\'' + s.sid + '\')">' +
            (s.name || 'UNNAMED') + '</span></td>' +
            '<td>' + s.basin + '</td>' +
            '<td class="mono">' + (s.peak_wind_kt || '—') + ' kt</td>' +
            '<td class="mono">' + (s.min_pres_hpa || '—') + ' hPa</td>' +
            '<td class="mono">' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td class="ace-bar-cell"><span class="ace-bar" style="width:' + barWidth + '%;background:' + color + ';"></span> ' +
            '<span style="font-size:0.72rem;color:var(--text-dim);">' + pct.toFixed(1) + '%</span></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('ace-year-table').innerHTML = html;
}

window.aceJumpToStorm = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) {
        closeACEModal();
        selectedStorm = storm;
        selectStorm(storm);
        viewStormDetail();
    }
};

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════

function showToast(message) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.style.display = '';
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
        el.style.display = 'none';
    }, 3000);
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
    loadData();

    // Close ACE modal on Escape
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            var modal = document.getElementById('ace-modal');
            if (modal && modal.style.display !== 'none') {
                closeACEModal();
            }
        }
    });
});

})();
