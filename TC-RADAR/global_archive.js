/* ══════════════════════════════════════════════════════════════
   Global TC Archive — Frontend Logic
   TC-RADAR · Dr. Michael Fischer · University of Miami / NOAA HRD
   ══════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ── Configuration ────────────────────────────────────────────
var API_BASE = 'https://tc-radar-api.onrender.com';
var STORMS_JSON = 'ibtracs_storms.json';
var TRACKS_JSON = 'ibtracs_tracks.json';

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

    // Load track data (larger file — may take a moment)
    fetch(TRACKS_JSON)
        .then(function (r) { return r.json(); })
        .then(function (data) {
            allTracks = data;
            console.log('Loaded tracks for ' + Object.keys(data).length + ' storms');
        })
        .catch(function (err) {
            console.warn('Track data not loaded:', err);
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

    // IR panel
    var irPanel = document.getElementById('ir-panel');
    if (storm.hursat) {
        irPanel.style.display = '';
        document.getElementById('ir-frame-unavailable').style.display = 'none';
        document.getElementById('ir-status').textContent = 'Checking HURSAT availability...';
        loadHURSAT(storm);
    } else {
        irPanel.style.display = '';
        document.getElementById('ir-frame-unavailable').style.display = 'flex';
        document.getElementById('ir-frame-img').style.display = 'none';
        document.getElementById('ir-status').textContent = '';
        stopIRPlayback();
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

    Plotly.newPlot('timeline-chart', [windTrace, presTrace], layout, PLOTLY_CONFIG);

    // Click handler to sync IR
    document.getElementById('timeline-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedTime = data.points[0].x;
            syncIRToTime(clickedTime);
        }
    });
}

function renderDetailMap(track, storm) {
    // Destroy existing map
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
        var gen = validPts[0];
        L.circleMarker([gen.la, gen.lo], {
            radius: 6, color: '#fff', fillColor: '#60a5fa', fillOpacity: 1, weight: 2
        }).bindTooltip('Genesis: ' + (gen.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);

        // LMI marker
        var lmiPt = validPts.reduce(function (max, p) { return (p.w || 0) > (max.w || 0) ? p : max; }, validPts[0]);
        if (lmiPt) {
            L.circleMarker([lmiPt.la, lmiPt.lo], {
                radius: 8, color: '#fff', fillColor: getIntensityColor(lmiPt.w), fillOpacity: 1, weight: 2
            }).bindTooltip('Peak: ' + (lmiPt.w || '?') + ' kt @ ' + (lmiPt.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);
        }

        // End marker
        var end = validPts[validPts.length - 1];
        L.circleMarker([end.la, end.lo], {
            radius: 5, color: '#fff', fillColor: '#6b7280', fillOpacity: 1, weight: 2
        }).bindTooltip('Dissipation: ' + (end.t || '').substring(0, 10), { className: 'track-tooltip' }).addTo(detailMap);

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
    stopIRPlayback();

    // Try to load from API
    fetch(API_BASE + '/global/hursat/meta?sid=' + encodeURIComponent(storm.sid))
        .then(function (r) {
            if (!r.ok) throw new Error('HURSAT metadata not available');
            return r.json();
        })
        .then(function (meta) {
            if (!meta.available || meta.n_frames === 0) {
                document.getElementById('ir-status').textContent = 'No HURSAT frames found';
                document.getElementById('ir-frame-unavailable').style.display = 'flex';
                document.getElementById('ir-frame-img').style.display = 'none';
                return;
            }
            irMeta = meta;
            document.getElementById('ir-slider').max = meta.n_frames - 1;
            document.getElementById('ir-slider').value = 0;
            document.getElementById('ir-status').textContent = meta.n_frames + ' frames available';
            document.getElementById('ir-frame-img').style.display = '';
            document.getElementById('ir-frame-unavailable').style.display = 'none';

            // Start loading frames progressively
            loadIRFrame(0);
        })
        .catch(function (err) {
            console.warn('HURSAT load failed:', err);
            document.getElementById('ir-status').textContent = 'API not connected — deploy to Render to enable';
            document.getElementById('ir-frame-unavailable').style.display = 'flex';
            document.getElementById('ir-frame-img').style.display = 'none';
        });
}

function loadIRFrame(idx) {
    if (!irMeta || !selectedStorm) return;

    var frameEl = document.getElementById('ir-frame-img');
    var loadingEl = document.getElementById('ir-frame-loading');

    // Check cache
    if (irFrames[idx]) {
        frameEl.src = irFrames[idx].frame;
        updateIRMeta(idx);
        return;
    }

    loadingEl.style.display = 'flex';

    fetch(API_BASE + '/global/hursat/frame?sid=' + encodeURIComponent(selectedStorm.sid) + '&frame_idx=' + idx)
        .then(function (r) {
            if (!r.ok) throw new Error('Frame not available');
            return r.json();
        })
        .then(function (data) {
            irFrames[idx] = data;
            if (irFrameIdx === idx) {
                frameEl.src = data.frame;
            }
            updateIRMeta(idx);
            loadingEl.style.display = 'none';
        })
        .catch(function (err) {
            console.warn('Frame load failed:', err);
            loadingEl.style.display = 'none';
        });
}

function updateIRMeta(idx) {
    var datetimeEl = document.getElementById('ir-datetime');
    var frameInfoEl = document.getElementById('ir-frame-info');

    if (irMeta && irMeta.frames && irMeta.frames[idx]) {
        datetimeEl.textContent = irMeta.frames[idx].datetime || '';
    }
    frameInfoEl.textContent = 'Frame ' + (idx + 1) + ' / ' + (irMeta ? irMeta.n_frames : '?');
    document.getElementById('ir-slider').value = idx;
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
        irFrameIdx = (irFrameIdx + 1) % irMeta.n_frames;
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
});

})();
