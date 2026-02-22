const API_BASE = 'https://tc-radar-api.onrender.com';

let allData = null;
let markers = null;
let allMarkers = [];
let currentCaseIndex = null;

const filters = {
    minIntensity:0, maxIntensity:200,
    minVmaxChange:-100, maxVmaxChange:85,
    minTilt:0, maxTilt:200,
    minYear:1997, maxYear:2024,
    stormName:'all'
};

// ── Dark-themed map ──────────────────────────────────────────
const map = L.map('map', { center:[20,-60], zoom:4, zoomControl:true, tap:true, tapTolerance:15 });

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom:19, subdomains:'abcd'
}).addTo(map);

// ── Filter drawer toggle ─────────────────────────────────────
function toggleFilterDrawer() {
    const drawer = document.getElementById('filter-drawer');
    const btn = document.getElementById('filter-toggle');
    drawer.classList.toggle('open');
    btn.classList.toggle('active');
}

// ── Two-step Storm → Case selection ──────────────────────────
var _focusMode = false;
var _focusMarker = null;

function enterFocusMode(caseData) {
    _focusMode = true;
    if (markers) map.removeLayer(markers);
    if (_focusMarker) { map.removeLayer(_focusMarker); _focusMarker = null; }
    var color = getIntensityColor(caseData.vmax_kt);
    var icon = L.divIcon({
        className: 'custom-div-icon',
        html: '<div class="custom-marker" style="background-color:' + color + ';width:16px;height:16px;box-shadow:0 0 0 4px rgba(37,99,235,0.35);"></div>',
        iconSize: [16, 16], iconAnchor: [8, 8]
    });
    _focusMarker = L.marker([caseData.latitude, caseData.longitude], { icon: icon }).addTo(map);
    map.setView([caseData.latitude, caseData.longitude], 6, { animate: true });
    document.getElementById('map-wrapper').classList.add('focus-mode');
    setTimeout(function() { map.invalidateSize(); }, 380);
}

function exitFocusMode() {
    if (!_focusMode) return;
    _focusMode = false;
    if (_focusMarker) { map.removeLayer(_focusMarker); _focusMarker = null; }
    if (markers) map.addLayer(markers);
    document.getElementById('map-wrapper').classList.remove('focus-mode');
    // Reset dropdowns
    document.getElementById('storm-select').value = '';
    document.getElementById('case-select').innerHTML = '<option value="">\u2190 Select a storm first</option>';
    document.getElementById('case-select').disabled = true;
    document.getElementById('explore-btn').disabled = true;
    // Restore map filter to all
    filters.stormName = 'all';
    updateMarkers();
    setTimeout(function() { map.invalidateSize(); map.setView([20, -60], 4, { animate: true }); }, 380);
}

// Storm dropdown: filters the map AND populates the case dropdown
document.getElementById('storm-select').addEventListener('change', function() {
    var storm = this.value;
    var caseSelect = document.getElementById('case-select');
    var exploreBtn = document.getElementById('explore-btn');

    // Update map filter
    filters.stormName = storm || 'all';
    updateMarkers();

    // Populate case dropdown
    caseSelect.innerHTML = '';
    if (!storm) {
        caseSelect.innerHTML = '<option value="">\u2190 Select a storm first</option>';
        caseSelect.disabled = true;
        exploreBtn.disabled = true;
        return;
    }

    caseSelect.disabled = false;
    caseSelect.innerHTML = '<option value="">Choose a case\u2026</option>';
    var cases = allData.cases.filter(function(c) { return c.storm_name === storm; });
    cases.sort(function(a, b) { return a.datetime.localeCompare(b.datetime); });
    cases.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.case_index;
        var cat = getIntensityCategory(c.vmax_kt);
        var vStr = c.vmax_kt !== null ? ' [' + cat + ', ' + c.vmax_kt + ' kt]' : '';
        opt.textContent = c.datetime + vStr;
        caseSelect.appendChild(opt);
    });

    // Zoom map to storm's extent
    var lats = cases.map(function(c) { return c.latitude; });
    var lons = cases.map(function(c) { return c.longitude; });
    if (lats.length > 0) {
        var bounds = L.latLngBounds(
            [Math.min.apply(null, lats) - 2, Math.min.apply(null, lons) - 2],
            [Math.max.apply(null, lats) + 2, Math.max.apply(null, lons) + 2]
        );
        map.fitBounds(bounds, { padding: [40, 40], animate: true });
    }
});

// Case dropdown: enable explore button
document.getElementById('case-select').addEventListener('change', function() {
    document.getElementById('explore-btn').disabled = !this.value;
});

// Explore button
function exploreCaseGo() {
    var idx = parseInt(document.getElementById('case-select').value);
    if (isNaN(idx) || !allData) return;
    var caseData = allData.cases.find(function(c) { return c.case_index === idx; });
    if (!caseData) return;
    enterFocusMode(caseData);
    openSidePanel(caseData, true);
}

// ── Side panel ───────────────────────────────────────────────
function openSidePanel(caseData, fromQuickSelect) {
    currentCaseIndex = caseData.case_index;
    const idx = caseData.case_index;
    const padded = String(idx).padStart(4, '0');
    const imageUrl = 'images/v3m/v3m_swath_cf_' + padded + '.png';

    var backBtnHtml = _focusMode ?
        '<button class="focus-back-btn" onclick="exitFocusMode();closeSidePanel();">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>' +
        'Back to all cases</button>' : '';

    document.getElementById('side-panel-inner').innerHTML =
        '<button id="side-panel-close" onclick="closeSidePanel()">\u2715</button>' +
        backBtnHtml +
        '<div class="panel-storm-name">' + caseData.storm_name + '</div>' +
        '<div class="panel-mission">' + caseData.mission_id + ' \u00b7 ' + caseData.datetime + '</div>' +
        '<div class="panel-image-wrap" onclick="openImageModal(\'' + imageUrl + '\',\'' + caseData.storm_name + ' \u2013 ' + caseData.datetime + '\')">' +
            '<img src="' + imageUrl + '" alt="Quick-look: ' + caseData.storm_name + '" onerror="this.parentElement.style.display=\'none\'">' +
        '</div>' +
        '<div class="panel-image-label">Quick-look (2-km V<sub>t</sub>, WCM) \u00b7 click to enlarge</div>' +
        '<hr class="explorer-divider">' +
        '<div class="explorer-title">\uD83D\uDD2C Explore Data</div>' +
        '<div class="explorer-row"><label>Variable</label>' +
            '<select class="explorer-select" id="ep-var">' +
                '<optgroup label="WCM Recentered (2 km)">' +
                    '<option value="recentered_tangential_wind">Tangential Wind</option>' +
                    '<option value="recentered_radial_wind">Radial Wind</option>' +
                    '<option value="recentered_upward_air_velocity">Vertical Velocity</option>' +
                    '<option value="recentered_reflectivity">Reflectivity</option>' +
                    '<option value="recentered_wind_speed">Wind Speed</option>' +
                    '<option value="recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                    '<option value="recentered_relative_vorticity">Relative Vorticity</option>' +
                    '<option value="recentered_divergence">Divergence</option>' +
                '</optgroup>' +
                '<optgroup label="Tilt-Relative">' +
                    '<option value="total_recentered_tangential_wind">Tangential Wind</option>' +
                    '<option value="total_recentered_radial_wind">Radial Wind</option>' +
                    '<option value="total_recentered_upward_air_velocity">Vertical Velocity</option>' +
                    '<option value="total_recentered_reflectivity">Reflectivity</option>' +
                    '<option value="total_recentered_wind_speed">Wind Speed</option>' +
                    '<option value="total_recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                '</optgroup>' +
                '<optgroup label="Original Swath">' +
                    '<option value="swath_tangential_wind">Tangential Wind</option>' +
                    '<option value="swath_radial_wind">Radial Wind</option>' +
                    '<option value="swath_reflectivity">Reflectivity</option>' +
                    '<option value="swath_wind_speed">Wind Speed</option>' +
                    '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                '</optgroup>' +
            '</select>' +
        '</div>' +
        '<div class="explorer-row"><label>Contour Overlay <span style="font-weight:400;color:var(--slate);">(optional)</span></label>' +
            '<select class="explorer-select" id="ep-overlay" style="font-size:11px;">' +
                '<option value="">None</option>' +
                '<optgroup label="WCM Recentered (2 km)">' +
                    '<option value="recentered_tangential_wind">Tangential Wind</option>' +
                    '<option value="recentered_radial_wind">Radial Wind</option>' +
                    '<option value="recentered_upward_air_velocity">Vertical Velocity</option>' +
                    '<option value="recentered_reflectivity">Reflectivity</option>' +
                    '<option value="recentered_wind_speed">Wind Speed</option>' +
                    '<option value="recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                    '<option value="recentered_relative_vorticity">Relative Vorticity</option>' +
                    '<option value="recentered_divergence">Divergence</option>' +
                '</optgroup>' +
                '<optgroup label="Tilt-Relative">' +
                    '<option value="total_recentered_tangential_wind">Tangential Wind</option>' +
                    '<option value="total_recentered_radial_wind">Radial Wind</option>' +
                    '<option value="total_recentered_upward_air_velocity">Vertical Velocity</option>' +
                    '<option value="total_recentered_reflectivity">Reflectivity</option>' +
                    '<option value="total_recentered_wind_speed">Wind Speed</option>' +
                    '<option value="total_recentered_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                '</optgroup>' +
                '<optgroup label="Original Swath">' +
                    '<option value="swath_tangential_wind">Tangential Wind</option>' +
                    '<option value="swath_radial_wind">Radial Wind</option>' +
                    '<option value="swath_reflectivity">Reflectivity</option>' +
                    '<option value="swath_wind_speed">Wind Speed</option>' +
                    '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                '</optgroup>' +
            '</select>' +
            '<div style="display:flex;align-items:center;gap:6px;margin-top:3px;">' +
                '<label style="font-size:10px;white-space:nowrap;margin:0;">Interval:</label>' +
                '<input type="number" id="ep-contour-int" value="" placeholder="auto" style="width:60px;padding:3px 5px;font-size:11px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);">' +
                '<span style="font-size:10px;color:var(--slate);" id="ep-contour-units"></span>' +
            '</div>' +
        '</div>' +
        '<div class="explorer-row"><label>Colormap</label>' +
            '<select class="explorer-select" id="ep-cmap" style="font-size:11px;" onchange="applyCmap()">' +
                '<option value="">Default (from variable)</option>' +
                '<optgroup label="Sequential"><option value="Viridis">Viridis</option><option value="Inferno">Inferno</option><option value="Magma">Magma</option><option value="Plasma">Plasma</option><option value="Cividis">Cividis</option><option value="Hot">Hot</option><option value="YlOrRd">YlOrRd</option><option value="YlGnBu">YlGnBu</option><option value="Blues">Blues</option><option value="Reds">Reds</option><option value="Greys">Greys</option></optgroup>' +
                '<optgroup label="Diverging"><option value="RdBu">RdBu (red-blue)</option><option value=\'[[0,"rgb(5,10,172)"],[0.5,"rgb(255,255,255)"],[1,"rgb(178,10,28)"]]\'>BuWtRd (blue-white-red)</option><option value="Picnic">Picnic</option><option value="Portland">Portland</option></optgroup>' +
                '<optgroup label="Other"><option value="Jet">Jet</option><option value="Rainbow">Rainbow</option><option value="Electric">Electric</option><option value="Earth">Earth</option><option value="Blackbody">Blackbody</option></optgroup>' +
            '</select>' +
        '</div>' +
        '<div class="explorer-row"><label>Color Range <span style="font-weight:400;color:var(--slate);">(override)</span></label>' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
                '<input type="number" id="ep-vmin" placeholder="min" step="any" style="width:70px;padding:3px 5px;font-size:11px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyColorRange()">' +
                '<span style="font-size:11px;color:var(--slate);">to</span>' +
                '<input type="number" id="ep-vmax" placeholder="max" step="any" style="width:70px;padding:3px 5px;font-size:11px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyColorRange()">' +
                '<button onclick="resetColorRange()" title="Reset to variable default" style="padding:2px 6px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);cursor:pointer;color:var(--slate);">\u21BA</button>' +
            '</div>' +
        '</div>' +
        '<div class="explorer-row"><label>Height Level</label>' +
            '<div class="explorer-level-row">' +
                '<input type="range" id="ep-level" min="0" max="18" step="0.5" value="2" oninput="document.getElementById(\'ep-level-val\').textContent = parseFloat(this.value).toFixed(1)+\' km\'">' +
                '<span class="explorer-level-value" id="ep-level-val">2.0 km</span>' +
            '</div>' +
            '<div class="anim-controls">' +
                '<button class="anim-btn" onclick="animStep(-1)" title="Previous level">\u25C0</button>' +
                '<button class="anim-btn" id="anim-play-btn" onclick="animToggle()" title="Play/Pause">\u25B6</button>' +
                '<button class="anim-btn" onclick="animStep(1)" title="Next level">\u25B6\u25B6</button>' +
                '<span class="anim-speed" id="anim-speed-label">0.8s / level</span>' +
            '</div>' +
        '</div>' +
        '<button class="generate-btn" id="ep-btn" onclick="generateCustomPlot()">Generate Plot</button>' +
        '<button class="cs-btn" id="cs-btn" onclick="toggleCrossSection()" disabled>\u2702 Draw Cross Section</button>' +
        '<button class="cs-btn" id="az-btn" onclick="fetchAzimuthalMean()" disabled style="margin-top:4px;">\u27F3 Azimuthal Mean</button>' +
        '<div class="explorer-row" id="az-controls" style="margin-top:6px;"><label>Coverage Threshold</label>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
                '<input type="range" id="az-coverage" min="0" max="100" step="5" value="50" class="az-cov-slider" oninput="document.getElementById(\'az-cov-val\').textContent = this.value+\'%\'">' +
                '<span style="font-size:12px;font-weight:600;color:var(--cyan);min-width:36px;font-family:\'JetBrains Mono\',monospace;" id="az-cov-val">50%</span>' +
            '</div>' +
        '</div>' +
        '<div class="cs-status" id="cs-status"></div>' +
        '<div class="explorer-result" id="ep-result"></div>' +
        '<div class="cs-result" id="cs-result"></div>' +
        '<div class="az-result" id="az-result"></div>';

    document.getElementById('side-panel').classList.add('open');
    setTimeout(function() { map.invalidateSize(); }, 360);
}

function closeSidePanel() {
    document.getElementById('side-panel').classList.remove('open');
    currentCaseIndex = null;
    animStop();
    _csMode = false; _csPointA = null; _removeRubberBand();
    exitFocusMode();
    setTimeout(function() { map.invalidateSize(); }, 360);
}

// ── State for animation & cross-section ──────────────────────
var _animTimer = null;
var _animPlaying = false;
var _dataCache = {};
var _csMode = false;
var _csPointA = null;
var _csMouseHandler = null;

function _startRubberBand(plotDiv, pxA, pyA) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'cs-rubber-band';
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('stroke', '#ef4444'); line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '6,4');
    line.setAttribute('x1', pxA); line.setAttribute('y1', pyA);
    svg.appendChild(line);
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '4'); circle.setAttribute('fill', 'rgba(239,68,68,0.5)');
    circle.setAttribute('stroke', 'white'); circle.setAttribute('stroke-width', '1');
    svg.appendChild(circle);
    plotDiv.parentElement.style.position = 'relative';
    plotDiv.parentElement.appendChild(svg);
    _csMouseHandler = function(e) {
        var rect = plotDiv.getBoundingClientRect();
        line.setAttribute('x2', e.clientX - rect.left);
        line.setAttribute('y2', e.clientY - rect.top);
        circle.setAttribute('cx', e.clientX - rect.left);
        circle.setAttribute('cy', e.clientY - rect.top);
    };
    plotDiv.addEventListener('mousemove', _csMouseHandler);
}

function _removeRubberBand() {
    var svg = document.getElementById('cs-rubber-band');
    if (svg) svg.remove();
    if (_csMouseHandler) {
        var plotDiv = document.getElementById('plotly-chart');
        if (plotDiv) plotDiv.removeEventListener('mousemove', _csMouseHandler);
        _csMouseHandler = null;
    }
}

function generateCustomPlot(callback) {
    if (currentCaseIndex === null) return;
    _lastAzJson = null;
    var variable = document.getElementById('ep-var').value;
    var level_km = document.getElementById('ep-level').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var resultDiv = document.getElementById('ep-result');
    var btn = document.getElementById('ep-btn');
    btn.disabled = true; btn.textContent = 'Generating\u2026';
    if (!_animPlaying) resultDiv.innerHTML = '<div class="explorer-status loading">\u23F3 Fetching data from API\u2026 (may take ~30s if service is waking up)</div>';
    var cacheKey = currentCaseIndex + '_' + variable + '_' + level_km + '_' + overlay;
    if (_dataCache[cacheKey]) {
        renderPlotFromJSON(_dataCache[cacheKey], resultDiv);
        btn.disabled = false; btn.textContent = 'Generate Plot';
        if (callback) callback(); return;
    }
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    var url = API_BASE + '/data?case_index=' + currentCaseIndex + '&variable=' + variable + '&level_km=' + level_km + '&data_type=swath';
    if (overlay) url += '&overlay=' + overlay;
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { _dataCache[cacheKey] = json; renderPlotFromJSON(json, resultDiv); if (callback) callback(); })
        .catch(function(err) {
            var msg = err.name === 'AbortError' ? '\u26A0\uFE0F Request timed out (90s). The API may be cold-starting \u2014 try again in a minute.' : '\u26A0\uFE0F ' + err.message;
            resultDiv.innerHTML = '<div class="explorer-status error">' + msg + '</div>'; animStop();
        })
        .finally(function() { clearTimeout(timeout); btn.disabled = false; btn.textContent = 'Generate Plot'; });
}

// ── Contour overlay helper ────────────────────────────────────
function buildOverlayContours(json, x, y, isCS) {
    if (!json.overlay) return [];
    var ov = json.overlay;
    var ovData = isCS ? ov.cross_section : ov.data;
    if (!ovData) return [];
    try {
        var intInput = document.getElementById('ep-contour-int');
        var interval = intInput ? parseFloat(intInput.value) : NaN;
        if (isNaN(interval) || interval <= 0) {
            var flat = ovData.flat().filter(function(v) { return v !== null && !isNaN(v); });
            if (flat.length === 0) return [];
            var mn = Infinity, mx = -Infinity;
            for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
            interval = parseFloat(((mx - mn) / 10).toPrecision(1));
            if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
        }
        var xCoord = isCS ? json.distance_km : x;
        var yCoord = isCS ? json.height_km : y;
        var baseContour = { z: ovData, x: xCoord, y: yCoord, type: 'contour', showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(255,255,255,0.8)' } } };
        var traces = [];
        if (ov.vmax > interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (+)', showlegend: false }));
        if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (\u2212)', showlegend: false }));
        return traces;
    } catch (e) { console.warn('Contour overlay error:', e); return []; }
}

// ── Colormap switcher ────────────────────────────────────────
var _defaultColorscale = null, _defaultVmin = null, _defaultVmax = null;

function applyCmap() {
    var sel = document.getElementById('ep-cmap'); if (!sel) return;
    var cs = sel.value;
    if (!cs && _defaultColorscale) cs = _defaultColorscale; if (!cs) return;
    var colorscale; try { colorscale = JSON.parse(cs); } catch(e) { colorscale = cs; }
    ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen'].forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        Plotly.restyle(plotDiv, { colorscale: [colorscale] }, [0]);
    });
    if (window._lastPlotlyData) window._lastPlotlyData.heatmap.colorscale = colorscale;
}

function _getActiveVmin() { var inp = document.getElementById('ep-vmin'); if (inp && inp.value !== '') return parseFloat(inp.value); return _defaultVmin; }
function _getActiveVmax() { var inp = document.getElementById('ep-vmax'); if (inp && inp.value !== '') return parseFloat(inp.value); return _defaultVmax; }

function applyColorRange() {
    var zmin = _getActiveVmin(), zmax = _getActiveVmax(); if (zmin === null || zmax === null) return;
    ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen'].forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        Plotly.restyle(plotDiv, { zmin: [zmin], zmax: [zmax] }, [0]);
    });
    if (window._lastPlotlyData) { window._lastPlotlyData.heatmap.zmin = zmin; window._lastPlotlyData.heatmap.zmax = zmax; }
}

function resetColorRange() {
    var vminInput = document.getElementById('ep-vmin'), vmaxInput = document.getElementById('ep-vmax');
    if (vminInput) vminInput.value = ''; if (vmaxInput) vmaxInput.value = '';
    if (_defaultVmin !== null && _defaultVmax !== null) {
        ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen'].forEach(function(id) {
            var plotDiv = document.getElementById(id);
            if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
            Plotly.restyle(plotDiv, { zmin: [_defaultVmin], zmax: [_defaultVmax] }, [0]);
        });
        if (window._lastPlotlyData) { window._lastPlotlyData.heatmap.zmin = _defaultVmin; window._lastPlotlyData.heatmap.zmax = _defaultVmax; }
    }
}

function renderPlotFromJSON(json, resultDiv) {
    resultDiv.innerHTML = '<div style="position:relative;"><div id="plotly-chart" style="width:100%;height:360px;border-radius:6px;overflow:hidden;"></div><button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button></div><div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover for values \u00b7 scroll to zoom \u00b7 drag to pan \u00b7 \u26F6 expand</div>';

    var zData = json.data, x = json.x, y = json.y, varInfo = json.variable, meta = json.case_meta;
    _defaultColorscale = varInfo.colorscale; _defaultVmin = varInfo.vmin; _defaultVmax = varInfo.vmax;
    var vminInput = document.getElementById('ep-vmin'), vmaxInput = document.getElementById('ep-vmax');
    if (vminInput) vminInput.placeholder = varInfo.vmin; if (vmaxInput) vmaxInput.placeholder = varInfo.vmax;

    var cmapSel = document.getElementById('ep-cmap');
    var activeColorscale = varInfo.colorscale;
    if (cmapSel && cmapSel.value) { try { activeColorscale = JSON.parse(cmapSel.value); } catch(e) { activeColorscale = cmapSel.value; } }
    var activeVmin = _getActiveVmin(), activeVmax = _getActiveVmax();

    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = meta.storm_name + ' | ' + meta.datetime + vmaxStr + '<br>' + varInfo.display_name + ' @ ' + json.actual_level_km.toFixed(1) + ' km' + overlayLabel;

    var heatmap = { z: zData, x: x, y: y, type: 'heatmap', colorscale: activeColorscale, zmin: activeVmin, zmax: activeVmax, colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 12, len: 0.85 }, hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>X: %{x:.0f} km<br>Y: %{y:.0f} km<extra></extra>', hoverongaps: false };
    var shapes = [];
    if (meta.rmw_km && !isNaN(meta.rmw_km)) shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: -meta.rmw_km, y0: -meta.rmw_km, x1: meta.rmw_km, y1: meta.rmw_km, line: { color: 'white', width: 1.5, dash: 'dash' } });

    var plotBg = '#0a1628';
    var baseLayout = { paper_bgcolor: plotBg, plot_bgcolor: plotBg, xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa' } }, tickfont: { color: '#aaa' }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false, scaleanchor: 'y' }, yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa' } }, tickfont: { color: '#aaa' }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, shapes: shapes, hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } }, showlegend: false };
    var config = { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'], displaylogo: false };
    var smallLayout = Object.assign({}, baseLayout, { title: { text: title, font: { color: '#e5e7eb', size: 11 }, y: 0.98, x: 0.5, xanchor: 'center' }, margin: { l: 52, r: 16, t: json.overlay ? 66 : 50, b: 44 }, xaxis: Object.assign({}, baseLayout.xaxis, { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 } }), yaxis: Object.assign({}, baseLayout.yaxis, { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 } }) });

    var overlayTraces = buildOverlayContours(json, x, y);
    Plotly.newPlot('plotly-chart', [heatmap].concat(overlayTraces), smallLayout, config);
    window._lastPlotlyData = { heatmap: heatmap, overlayTraces: overlayTraces, baseLayout: baseLayout, title: title, config: config };
    var csBtn = document.getElementById('cs-btn'); if (csBtn) csBtn.disabled = false;
    var azBtn = document.getElementById('az-btn'); if (azBtn) azBtn.disabled = false;
    document.getElementById('plotly-chart').on('plotly_click', handlePlotClick);
}

// ── Height animation ─────────────────────────────────────────
function animToggle() { if (_animPlaying) animStop(); else animStart(); }
function animStart() { _animPlaying = true; var btn = document.getElementById('anim-play-btn'); if (btn) { btn.textContent = '\u23F8'; btn.classList.add('active'); } animTick(); }
function animStop() { _animPlaying = false; if (_animTimer) { clearTimeout(_animTimer); _animTimer = null; } var btn = document.getElementById('anim-play-btn'); if (btn) { btn.textContent = '\u25B6'; btn.classList.remove('active'); } }
function animTick() { if (!_animPlaying) return; generateCustomPlot(function() { if (!_animPlaying) return; _animTimer = setTimeout(function() { animStep(1); animTick(); }, 800); }); }
function animStep(dir) { var slider = document.getElementById('ep-level'); if (!slider) return; var val = parseFloat(slider.value) + dir * 0.5; if (val > 18) val = 0; if (val < 0) val = 18; slider.value = val; document.getElementById('ep-level-val').textContent = val.toFixed(1) + ' km'; if (!_animPlaying) generateCustomPlot(); }

// ── Cross-section ────────────────────────────────────────────
function toggleCrossSection() {
    _csMode = !_csMode; _csPointA = null; _removeRubberBand();
    var btn = document.getElementById('cs-btn'), status = document.getElementById('cs-status');
    if (_csMode) { btn.classList.add('active'); btn.textContent = '\u2702 Click point A on plot\u2026'; if (status) status.textContent = 'Click the starting point on the plan view above'; }
    else { btn.classList.remove('active'); btn.textContent = '\u2702 Draw Cross Section'; if (status) status.textContent = ''; }
}

function handlePlotClick(eventData) {
    if (!_csMode || !eventData.points || !eventData.points.length) return;
    var pt = eventData.points[0], x = pt.x, y = pt.y;
    var status = document.getElementById('cs-status'), plotDiv = document.getElementById('plotly-chart');
    if (!_csPointA) {
        _csPointA = { x: x, y: y };
        var btn = document.getElementById('cs-btn'); if (btn) btn.textContent = '\u2702 Click point B on plot\u2026';
        if (status) status.textContent = 'A: (' + x.toFixed(0) + ', ' + y.toFixed(0) + ') km \u2014 now click the end point';
        var currentShapes = (plotDiv.layout.shapes || []).slice();
        currentShapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: x-4, y0: y-4, x1: x+4, y1: y+4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } });
        Plotly.relayout(plotDiv, { shapes: currentShapes });
        var rect = plotDiv.getBoundingClientRect();
        _startRubberBand(plotDiv, eventData.event.clientX - rect.left, eventData.event.clientY - rect.top);
    } else {
        var a = _csPointA, b = { x: x, y: y };
        _csMode = false; _csPointA = null; _removeRubberBand();
        var btn2 = document.getElementById('cs-btn'); if (btn2) { btn2.classList.remove('active'); btn2.textContent = '\u2702 Draw Cross Section'; }
        if (status) status.textContent = 'A\u2192B: (' + a.x.toFixed(0) + ',' + a.y.toFixed(0) + ') \u2192 (' + b.x.toFixed(0) + ',' + b.y.toFixed(0) + ') km';
        var currentShapes2 = (plotDiv.layout.shapes || []).slice();
        var csShapes = [
            { type: 'line', xref: 'x', yref: 'y', x0: a.x, y0: a.y, x1: b.x, y1: b.y, line: { color: '#ef4444', width: 2.5 } },
            { type: 'circle', xref: 'x', yref: 'y', x0: b.x-4, y0: b.y-4, x1: b.x+4, y1: b.y+4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } }
        ];
        Plotly.relayout(plotDiv, { shapes: currentShapes2.concat(csShapes) });
        if (window._lastPlotlyData) {
            var baseShapes = window._lastPlotlyData.baseLayout.shapes || [];
            window._lastPlotlyData.baseLayout.shapes = baseShapes.concat(csShapes).concat([{ type: 'circle', xref: 'x', yref: 'y', x0: a.x-4, y0: a.y-4, x1: a.x+4, y1: a.y+4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } }]);
        }
        fetchCrossSection(a, b);
    }
}

function fetchCrossSection(a, b) {
    var variable = document.getElementById('ep-var').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var csResult = document.getElementById('cs-result'); if (!csResult) return;
    csResult.innerHTML = '<div class="explorer-status loading">\u23F3 Computing cross-section\u2026</div>';
    var url = API_BASE + '/cross_section?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=swath&x0=' + a.x + '&y0=' + a.y + '&x1=' + b.x + '&y1=' + b.y + '&n_points=150';
    if (overlay) url += '&overlay=' + overlay;
    fetch(url)
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { csResult.innerHTML = '<div class="explorer-status" style="color:#10b981;">\u2713 Cross-section ready \u2014 opening expanded view</div>'; openPlotModal(json); })
        .catch(function(err) { csResult.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + err.message + '</div>'; });
}

function renderCrossSectionInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var csData = json.cross_section, distance_km = json.distance_km, height_km = json.height_km, varInfo = json.variable, meta = json.case_meta, ep = json.endpoints;
    var fontSize = fullsize ? { title:13,axis:12,tick:10,cbar:12,cbarTick:10,hover:13 } : { title:10,axis:9,tick:8,cbar:9,cbarTick:8,hover:11 };
    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }
    var av = _getActiveVmin(), avx = _getActiveVmax();
    var heatmap = { z: csData, x: distance_km, y: height_km, type: 'heatmap', colorscale: csColorscale, zmin: av !== null ? av : varInfo.vmin, zmax: avx !== null ? avx : varInfo.vmax, colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } }, tickfont: { color: '#ccc', size: fontSize.cbarTick }, thickness: fullsize?14:10, len: 0.85 }, hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Distance: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>', hoverongaps: false };
    var csOverlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = 'Cross Section: (' + ep.x0.toFixed(0) + ',' + ep.y0.toFixed(0) + ') \u2192 (' + ep.x1.toFixed(0) + ',' + ep.y1.toFixed(0) + ') km' + csOverlayLabel;
    var plotBg = '#0a1628';
    var layout = { title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.97, x: 0.5, xanchor: 'center' }, paper_bgcolor: plotBg, plot_bgcolor: plotBg, xaxis: { title: { text: 'Distance along line (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, margin: fullsize ? { l:55,r:24,t:json.overlay?56:40,b:46 } : { l:45,r:12,t:json.overlay?50:36,b:38 }, hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } }, showlegend: false };
    var csOverlayTraces = buildOverlayContours(json, null, null, true);
    Plotly.newPlot(targetId, [heatmap].concat(csOverlayTraces), layout, { responsive: true, displayModeBar: fullsize, displaylogo: false, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'] });
}

// ── Azimuthal Mean ─────────────────────────────────────────────
var _lastAzJson = null;

function fetchAzimuthalMean() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var covSlider = document.getElementById('az-coverage');
    var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
    var resultDiv = document.getElementById('az-result'), btn = document.getElementById('az-btn');
    resultDiv.innerHTML = '<div class="explorer-status">Computing azimuthal mean\u2026</div>';
    btn.disabled = true; btn.textContent = '\u27F3 Computing\u2026';
    var url = API_BASE + '/azimuthal_mean?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=swath&coverage_min=' + coverage;
    if (overlay && overlay !== 'none') url += '&overlay=' + overlay;
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) { _lastAzJson = json; renderAzimuthalMeanInto('az-result', json, false); openPlotModal(); })
        .catch(function(err) { resultDiv.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.name === 'AbortError' ? 'Request timed out (90s).' : err.message) + '</div>'; })
        .finally(function() { clearTimeout(timeout); btn.disabled = false; btn.textContent = '\u27F3 Azimuthal Mean'; });
}

function renderAzimuthalMeanInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var azData = json.azimuthal_mean, radius_km = json.radius_km, height_km = json.height_km, varInfo = json.variable, meta = json.case_meta;
    var fontSize = fullsize ? { title:13,axis:12,tick:10,cbar:12,cbarTick:10,hover:13 } : { title:10,axis:9,tick:8,cbar:9,cbarTick:8,hover:11 };
    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }
    var av = _getActiveVmin(), avx = _getActiveVmax();
    var heatmap = { z: azData, x: radius_km, y: height_km, type: 'heatmap', colorscale: csColorscale, zmin: av !== null ? av : varInfo.vmin, zmax: avx !== null ? avx : varInfo.vmax, colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } }, tickfont: { color: '#ccc', size: fontSize.cbarTick }, thickness: fullsize?14:10, len: 0.85 }, hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>', hoverongaps: false };
    var azOverlayTraces = buildAzOverlayContours(json, radius_km, height_km);
    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = meta.storm_name + ' | ' + meta.datetime + vmaxStr + '<br>Azimuthal Mean: ' + varInfo.display_name + ' (\u2265' + covPct + '% coverage)' + overlayLabel;
    var shapes = [];
    if (meta.rmw_km && !isNaN(meta.rmw_km)) shapes.push({ type:'line',xref:'x',yref:'paper',x0:meta.rmw_km,x1:meta.rmw_km,y0:0,y1:1,line:{color:'white',width:1.5,dash:'dash'} });
    var plotBg = '#0a1628';
    var layout = { title: { text: title, font: { color: '#e5e7eb', size: fontSize.title }, y: 0.97, x: 0.5, xanchor: 'center' }, paper_bgcolor: plotBg, plot_bgcolor: plotBg, xaxis: { title: { text: 'Radius (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } }, tickfont: { color: '#aaa', size: fontSize.tick }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false }, margin: fullsize ? { l:55,r:24,t:json.overlay?66:50,b:46 } : { l:45,r:12,t:json.overlay?56:42,b:38 }, shapes: shapes, hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } }, showlegend: false };
    if (!fullsize) {
        el.innerHTML = '<div style="position:relative;"><div id="az-chart" style="width:100%;height:340px;border-radius:6px;overflow:hidden;"></div><button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button></div><div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover \u00b7 zoom \u00b7 pan \u00b7 \u26F6 expand</div>';
        Plotly.newPlot('az-chart', [heatmap].concat(azOverlayTraces), layout, { responsive:true,displayModeBar:false,displaylogo:false });
    } else {
        Plotly.newPlot(targetId, [heatmap].concat(azOverlayTraces), layout, { responsive:true,displayModeBar:true,displaylogo:false,modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
    }
}

function buildAzOverlayContours(json, radius_km, height_km) {
    if (!json.overlay) return []; var ov = json.overlay; var ovData = ov.azimuthal_mean; if (!ovData) return [];
    try {
        var intInput = document.getElementById('ep-contour-int'); var interval = intInput ? parseFloat(intInput.value) : NaN;
        if (isNaN(interval) || interval <= 0) { var flat = ovData.flat().filter(function(v){return v!==null&&!isNaN(v);}); if (flat.length===0) return []; var mn=Infinity,mx=-Infinity; for(var i=0;i<flat.length;i++){if(flat[i]<mn)mn=flat[i];if(flat[i]>mx)mx=flat[i];} interval=parseFloat(((mx-mn)/10).toPrecision(1)); if(!isFinite(interval)||interval<=0) interval=(mx-mn)/10||1; }
        var baseContour = { z:ovData,x:radius_km,y:height_km,type:'contour',showscale:false,hoverongaps:false,contours:{coloring:'none',showlabels:true,labelfont:{size:9,color:'rgba(255,255,255,0.8)'}} };
        var traces = [];
        if (ov.vmax > interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:interval,end:ov.vmax,size:interval}),line:{color:'rgba(0,0,0,0.7)',width:1.2,dash:'solid'},hovertemplate:'<b>'+ov.display_name+'</b>: %{z:.2f} '+ov.units+'<extra>contour</extra>',name:ov.display_name+' (+)',showlegend:false}));
        if (ov.vmin < -interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:ov.vmin,end:-interval,size:interval}),line:{color:'rgba(0,0,0,0.7)',width:1.2,dash:'dash'},hovertemplate:'<b>'+ov.display_name+'</b>: %{z:.2f} '+ov.units+'<extra>contour</extra>',name:ov.display_name+' (\u2212)',showlegend:false}));
        return traces;
    } catch(e) { console.warn('Az overlay contour error:',e); return []; }
}

// ── Intensity helpers ────────────────────────────────────────
function getIntensityColor(vmax) {
    if (!vmax) return '#6b7280'; if (vmax<34) return '#60a5fa'; if (vmax<64) return '#34d399';
    if (vmax<83) return '#fbbf24'; if (vmax<96) return '#fb923c'; if (vmax<113) return '#f87171';
    if (vmax<137) return '#ef4444'; return '#dc2626';
}
function getIntensityCategory(vmax) {
    if (!vmax) return 'Unknown'; if (vmax<34) return 'TD'; if (vmax<64) return 'TS';
    if (vmax<83) return 'Cat 1'; if (vmax<96) return 'Cat 2'; if (vmax<113) return 'Cat 3';
    if (vmax<137) return 'Cat 4'; return 'Cat 5';
}

function createPopupContent(caseData) {
    var intensity = caseData.vmax_kt !== null ? caseData.vmax_kt + ' kt' : 'N/A';
    var pressure = caseData.min_pressure_hpa !== null ? caseData.min_pressure_hpa + ' hPa' : 'N/A';
    var rmw = caseData.rmw_km !== null ? caseData.rmw_km + ' km' : 'N/A';
    var vmaxChange = caseData['24-h_vmax_change_kt'] !== null ? (caseData['24-h_vmax_change_kt']>0?'+':'') + caseData['24-h_vmax_change_kt'] + ' kt' : 'N/A';
    var tiltMag = caseData.tilt_magnitude_km !== null ? caseData.tilt_magnitude_km.toFixed(1) + ' km' : 'N/A';
    var category = getIntensityCategory(caseData.vmax_kt);
    var catColor = getIntensityColor(caseData.vmax_kt);
    var idx = caseData.case_index;
    return '<div class="popup-header"><div class="popup-storm-name">' + caseData.storm_name + '</div><div class="popup-mission">' + caseData.mission_id + '</div></div>' +
        '<div class="popup-row"><span class="popup-label">Date/Time:</span><span class="popup-value">' + caseData.datetime + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Intensity:</span><span class="popup-value"><span class="intensity-badge" style="background:' + catColor + '">' + category + '</span> ' + intensity + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">24-h Change:</span><span class="popup-value">' + vmaxChange + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Min Pressure:</span><span class="popup-value">' + pressure + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">RMW:</span><span class="popup-value">' + rmw + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Tilt Magnitude:</span><span class="popup-value">' + tiltMag + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Location:</span><span class="popup-value">' + Math.abs(caseData.latitude).toFixed(2) + '\u00b0' + (caseData.latitude>=0?'N':'S') + ', ' + Math.abs(caseData.longitude).toFixed(2) + '\u00b0' + (caseData.longitude<0?'W':'E') + '</span></div>' +
        '<button class="popup-explore-btn" onclick="openSidePanelById(' + idx + ')">\uD83D\uDD2C View Radar & Explore Data \u2192</button>';
}

function openSidePanelById(idx) { if (!allData) return; var caseData = allData.cases.find(function(c) { return c.case_index === idx; }); if (caseData) openSidePanel(caseData); }

// ── Filters ──────────────────────────────────────────────────
function passesFilters(c) {
    var vmax = c.vmax_kt || 0;
    if (vmax < filters.minIntensity || vmax > filters.maxIntensity) return false;
    if (filters.minVmaxChange !== -100 || filters.maxVmaxChange !== 85) { if (c['24-h_vmax_change_kt'] === null) return false; var vc = c['24-h_vmax_change_kt']; if (vc < filters.minVmaxChange || vc > filters.maxVmaxChange) return false; }
    if (filters.minTilt !== 0 || filters.maxTilt !== 200) { if (c.tilt_magnitude_km === null) return false; if (c.tilt_magnitude_km < filters.minTilt || c.tilt_magnitude_km > filters.maxTilt) return false; }
    if (c.year < filters.minYear || c.year > filters.maxYear) return false;
    if (filters.stormName !== 'all' && c.storm_name !== filters.stormName) return false;
    return true;
}

function updateMarkers() {
    if (!markers || !allData) return; markers.clearLayers(); var n = 0;
    allData.cases.forEach(function(c) { if (passesFilters(c)) { var m = allMarkers.find(function(m) { return m.caseIndex === c.case_index; }); if (m) { markers.addLayer(m.marker); n++; } } });
    document.getElementById('filtered-count').textContent = n;
}

function updateIntensitySlider() {
    var min = parseInt(document.getElementById('min-intensity').value), max = parseInt(document.getElementById('max-intensity').value);
    if (min > max) { document.getElementById('min-intensity').value = max; min = max; }
    filters.minIntensity = min; filters.maxIntensity = max;
    document.getElementById('min-intensity-value').textContent = min; document.getElementById('max-intensity-value').textContent = max;
    var rf = document.getElementById('intensity-range-fill'); rf.style.left = (min/200*100)+'%'; rf.style.width = ((max-min)/200*100)+'%'; updateMarkers();
}
function updateVmaxChangeSlider() {
    var min = parseInt(document.getElementById('min-vmax-change').value), max = parseInt(document.getElementById('max-vmax-change').value);
    if (min > max) { document.getElementById('min-vmax-change').value = max; min = max; }
    filters.minVmaxChange = min; filters.maxVmaxChange = max;
    document.getElementById('min-vmax-change-value').textContent = min; document.getElementById('max-vmax-change-value').textContent = max;
    var rf = document.getElementById('vmax-change-range-fill'); rf.style.left = ((min+100)/185*100)+'%'; rf.style.width = ((max-min)/185*100)+'%'; updateMarkers();
}
function updateTiltSlider() {
    var min = parseInt(document.getElementById('min-tilt').value), max = parseInt(document.getElementById('max-tilt').value);
    if (min > max) { document.getElementById('min-tilt').value = max; min = max; }
    filters.minTilt = min; filters.maxTilt = max;
    document.getElementById('min-tilt-value').textContent = min; document.getElementById('max-tilt-value').textContent = max;
    var rf = document.getElementById('tilt-range-fill'); rf.style.left = (min/200*100)+'%'; rf.style.width = ((max-min)/200*100)+'%'; updateMarkers();
}
function updateYearFilter() { var min = parseInt(document.getElementById('min-year').value), max = parseInt(document.getElementById('max-year').value); if (min > max) { document.getElementById('min-year').value = max; min = max; } filters.minYear = min; filters.maxYear = max; updateMarkers(); }
function updateStormFilter() { filters.stormName = document.getElementById('storm-select').value || 'all'; updateMarkers(); }

function resetFilters() {
    filters.minIntensity=0; filters.maxIntensity=200; document.getElementById('min-intensity').value=0; document.getElementById('max-intensity').value=200; updateIntensitySlider();
    filters.minVmaxChange=-100; filters.maxVmaxChange=85; document.getElementById('min-vmax-change').value=-100; document.getElementById('max-vmax-change').value=85; updateVmaxChangeSlider();
    filters.minTilt=0; filters.maxTilt=200; document.getElementById('min-tilt').value=0; document.getElementById('max-tilt').value=200; updateTiltSlider();
    filters.minYear=1997; filters.maxYear=2024; document.getElementById('min-year').value=1997; document.getElementById('max-year').value=2024;
    filters.stormName='all'; document.getElementById('storm-select').value=''; updateMarkers();
    // Also reset case dropdown
    document.getElementById('case-select').innerHTML = '<option value="">\u2190 Select a storm first</option>';
    document.getElementById('case-select').disabled = true;
    document.getElementById('explore-btn').disabled = true;
}

function initializeFilters() {
    document.getElementById('min-intensity').addEventListener('input', updateIntensitySlider);
    document.getElementById('max-intensity').addEventListener('input', updateIntensitySlider);
    document.getElementById('min-vmax-change').addEventListener('input', updateVmaxChangeSlider);
    document.getElementById('max-vmax-change').addEventListener('input', updateVmaxChangeSlider);
    document.getElementById('min-tilt').addEventListener('input', updateTiltSlider);
    document.getElementById('max-tilt').addEventListener('input', updateTiltSlider);
    document.getElementById('min-year').addEventListener('change', updateYearFilter);
    document.getElementById('max-year').addEventListener('change', updateYearFilter);
    // Storm filtering handled by two-step handler at top of file
    updateIntensitySlider(); updateVmaxChangeSlider(); updateTiltSlider();
}

// ── Pre-warm API ─────────────────────────────────────────────
fetch(API_BASE + '/health').catch(function(){});

// ── Load data ────────────────────────────────────────────────
fetch('tc_radar_metadata.json')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
        allData = data;
        document.getElementById('loading').style.display = 'none';
        document.getElementById('total-cases').textContent = data.total_cases.toLocaleString();
        document.getElementById('total-count').textContent = data.total_cases.toLocaleString();
        document.getElementById('filtered-count').textContent = data.total_cases.toLocaleString();

        var storms = new Set(data.cases.map(function(c) { return c.storm_name; }));
        document.getElementById('unique-storms').textContent = storms.size.toLocaleString();
        var years = data.cases.map(function(c) { return c.year; });
        document.getElementById('year-range').textContent = Math.min.apply(null, years) + '\u2013' + Math.max.apply(null, years);

        var stormSelect = document.getElementById('storm-select');
        Array.from(storms).sort().forEach(function(s) { var o = document.createElement('option'); o.value = s; o.textContent = s; stormSelect.appendChild(o); });

        markers = L.markerClusterGroup({
            maxClusterRadius: 30, disableClusteringAtZoom: 10, spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true,
            iconCreateFunction: function(cluster) {
                var n = cluster.getChildCount();
                var bg = n<10?'rgba(46,125,255,0.25)':n<50?'rgba(46,125,255,0.4)':n<100?'rgba(46,125,255,0.6)':n<200?'rgba(46,125,255,0.75)':'rgba(46,125,255,0.9)';
                return L.divIcon({ html:'<div style="background:'+bg+';color:white;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid rgba(255,255,255,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.4);backdrop-filter:blur(4px);font-family:\'JetBrains Mono\',monospace;">'+n+'</div>', className:'custom-cluster-icon', iconSize:L.point(40,40) });
            }
        });

        data.cases.forEach(function(caseData) {
            var color = getIntensityColor(caseData.vmax_kt);
            var icon = L.divIcon({ className:'custom-div-icon', html:'<div class="custom-marker" style="background-color:'+color+';width:12px;height:12px;box-shadow:0 0 6px '+color+'40;"></div>', iconSize:[12,12], iconAnchor:[6,6] });
            var marker = L.marker([caseData.latitude, caseData.longitude], { icon: icon });
            marker.bindPopup(createPopupContent(caseData), { maxWidth:320,minWidth:260,autoPan:true,autoPanPadding:[50,50],keepInView:true,closeButton:true,closeOnEscapeKey:true });
            allMarkers.push({ caseIndex: caseData.case_index, marker: marker });
            markers.addLayer(marker);
        });

        map.addLayer(markers);

        var legend = L.control({ position:'bottomright' });
        legend.onAdd = function() {
            var div = L.DomUtil.create('div','intensity-legend');
            div.innerHTML = '<h4>Intensity (kt)</h4><div class="legend-item"><div class="legend-color" style="background:#60a5fa"></div><span>TD (&lt;34)</span></div><div class="legend-item"><div class="legend-color" style="background:#34d399"></div><span>TS (34\u201363)</span></div><div class="legend-item"><div class="legend-color" style="background:#fbbf24"></div><span>Cat 1 (64\u201382)</span></div><div class="legend-item"><div class="legend-color" style="background:#fb923c"></div><span>Cat 2 (83\u201395)</span></div><div class="legend-item"><div class="legend-color" style="background:#f87171"></div><span>Cat 3 (96\u2013112)</span></div><div class="legend-item"><div class="legend-color" style="background:#ef4444"></div><span>Cat 4 (113\u2013136)</span></div><div class="legend-item"><div class="legend-color" style="background:#dc2626"></div><span>Cat 5 (137+)</span></div>';
            return div;
        };
        legend.addTo(map);
        initializeFilters();
    })
    .catch(function(err) { document.getElementById('loading').innerHTML = '<div style="color:#f87171;"><strong>Error loading data</strong><br><small>' + err.message + '</small></div>'; });

// ── Smooth scroll ────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(function(a) {
    a.addEventListener('click', function(e) { e.preventDefault(); var t = document.querySelector(this.getAttribute('href')); if (t) t.scrollIntoView({ behavior:'smooth', block:'start' }); });
});

// ── Fullscreen plot modal ─────────────────────────────────────
function openPlotModal(csJson) {
    if (!window._lastPlotlyData) return;
    var modal = document.getElementById('plotModal'), box = document.getElementById('plotModalBox');
    var csFull = document.getElementById('cs-fullscreen'), csDivider = document.getElementById('cs-full-divider');
    var azFull = document.getElementById('az-fullscreen'), azDivider = document.getElementById('az-full-divider');
    modal.classList.add('active'); document.body.style.overflow = 'hidden';
    var hasCrossSection = !!csJson, hasAzMean = !!_lastAzJson, hasSub = hasCrossSection || hasAzMean;
    if (hasSub) box.classList.add('split'); else box.classList.remove('split');
    csFull.style.display = hasCrossSection?'block':'none'; csDivider.style.display = hasCrossSection?'block':'none';
    azFull.style.display = hasAzMean?'block':'none'; azDivider.style.display = hasAzMean?'block':'none';
    var subCount = (hasCrossSection?1:0)+(hasAzMean?1:0);
    document.getElementById('plotly-fullscreen').style.height = subCount===0?'100%':subCount===1?'55%':'40%';

    var d = window._lastPlotlyData;
    var fullLayout = Object.assign({}, d.baseLayout, { title: { text: d.title, font: { color: '#e5e7eb', size: 15 }, y: 0.97, x: 0.5, xanchor: 'center' }, margin: { l:65,r:30,t:d.overlayTraces&&d.overlayTraces.length?76:60,b:55 }, xaxis: Object.assign({}, d.baseLayout.xaxis, { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 13 } }, tickfont: { color: '#aaa', size: 11 } }), yaxis: Object.assign({}, d.baseLayout.yaxis, { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 13 } }, tickfont: { color: '#aaa', size: 11 } }) });
    var fullHeatmap = Object.assign({}, d.heatmap, { colorbar: Object.assign({}, d.heatmap.colorbar, { title: { text: d.heatmap.colorbar.title.text, font: { color: '#ccc', size: 13 } }, tickfont: { color: '#ccc', size: 11 }, thickness: 16, len: 0.85 }) });
    Plotly.newPlot('plotly-fullscreen', [fullHeatmap].concat(d.overlayTraces||[]), fullLayout, d.config);
    if (hasCrossSection) renderCrossSectionInto('cs-fullscreen', csJson, true);
    if (hasAzMean) renderAzimuthalMeanInto('az-fullscreen', _lastAzJson, true);
}

function closePlotModal() {
    document.getElementById('plotModal').classList.remove('active');
    document.getElementById('plotModalBox').classList.remove('split');
    document.body.style.overflow = '';
    Plotly.purge('plotly-fullscreen');
    var csFull = document.getElementById('cs-fullscreen'); if (csFull) { Plotly.purge('cs-fullscreen'); csFull.style.display='none'; }
    document.getElementById('cs-full-divider').style.display='none';
    var azFull = document.getElementById('az-fullscreen'); if (azFull) { Plotly.purge('az-fullscreen'); azFull.style.display='none'; }
    document.getElementById('az-full-divider').style.display='none';
}

// ── Image modal ──────────────────────────────────────────────
function openImageModal(url, caption) { document.getElementById('imageModal').style.display = 'block'; document.getElementById('modalImage').src = url; document.getElementById('modalCaption').textContent = caption; }
function closeImageModal() { document.getElementById('imageModal').style.display = 'none'; }
document.addEventListener('click', function(e) { if (e.target===document.getElementById('imageModal')) closeImageModal(); });
document.addEventListener('keydown', function(e) { if (e.key==='Escape') { closeImageModal(); closePlotModal(); } });

// ── Hide scroll prompt on scroll ─────────────────────────────
var _scrollPromptHidden = false;
window.addEventListener('scroll', function() {
    if (!_scrollPromptHidden && window.scrollY > 50) { _scrollPromptHidden = true; var el = document.querySelector('.scroll-prompt'); if (el) el.style.opacity = '0'; }
});
