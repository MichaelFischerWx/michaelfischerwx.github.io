const API_BASE = 'https://tc-radar-api.onrender.com';

let allData = null;
var _activeDataType = 'swath';  // 'swath' or 'merge'
function _getActiveData() { return _activeDataType === 'merge' ? mergeData : allData; }
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
    document.getElementById('side-panel').classList.add('focus-panel');
    setTimeout(function() { map.invalidateSize(); }, 380);
}

function exitFocusMode() {
    if (!_focusMode) return;
    _focusMode = false;
    if (_focusMarker) { map.removeLayer(_focusMarker); _focusMarker = null; }
    if (markers) map.addLayer(markers);
    document.getElementById('map-wrapper').classList.remove('focus-mode');
    document.getElementById('side-panel').classList.remove('focus-panel');
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
    var cases = _getActiveData().cases.filter(function(c) { return c.storm_name === storm; });
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
    if (isNaN(idx) || !_getActiveData()) return;
    var caseData = _getActiveData().cases.find(function(c) { return c.case_index === idx; });
    if (!caseData) return;
    enterFocusMode(caseData);
    openSidePanel(caseData, true);
}

// ── Side panel ───────────────────────────────────────────────
function openSidePanel(caseData, fromQuickSelect) {
    currentCaseIndex = caseData.case_index;
    _currentSddc = (caseData.sddc !== null && caseData.sddc !== undefined && caseData.sddc !== 9999) ? caseData.sddc : null;
    const idx = caseData.case_index;
    const padded = String(idx).padStart(4, '0');
    const imgPrefix = _activeDataType === 'merge' ? 'v3m_merge_cf_' : 'v3m_swath_cf_';
    const imageUrl = 'images/v3m/' + imgPrefix + padded + '.png';

    var backBtnHtml = _focusMode ?
        '<button class="focus-back-btn" onclick="exitFocusMode();closeSidePanel();">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>' +
        'Back to all cases</button>' : '';

    document.getElementById('side-panel-inner').innerHTML =
        '<button id="side-panel-close" onclick="closeSidePanel()">\u2715</button>' +
        backBtnHtml +
        '<div class="panel-storm-name">' + caseData.storm_name +
            (_activeDataType === 'merge' ? ' <span style="font-size:10px;background:#4f46e5;color:#fff;padding:1px 6px;border-radius:3px;vertical-align:middle;">MERGE</span>' : '') +
        '</div>' +
        '<div class="panel-mission">' + caseData.mission_id + ' \u00b7 ' + caseData.datetime +
            (caseData.number_of_swaths ? ' \u00b7 ' + caseData.number_of_swaths + ' swaths' : '') +
        '</div>' +

        '<div class="explorer-layout">' +
            // ── LEFT: Display area + action buttons ──
            '<div class="explorer-display">' +
                '<div id="display-area">' +
                    '<div id="thumbnail-wrap">' +
                        '<div class="panel-image-wrap" id="thumb-img-wrap">' +
                            '<img id="thumb-img" src="' + imageUrl + '" alt="Quick-look: ' + caseData.storm_name + '">' +
                        '</div>' +
                        '<div class="panel-image-label">Quick-look (2-km V<sub>t</sub>, WCM) \u00b7 ' + (_activeDataType === 'merge' ? 'Merged' : 'Swath') + ' \u00b7 click to enlarge</div>' +
                    '</div>' +
                    '<div class="explorer-result" id="ep-result"></div>' +
                    '<div class="cs-result" id="cs-result"></div>' +
                    '<div class="az-result" id="az-result"></div>' +
                    '<div class="sq-result" id="sq-result"></div>' +
                    '<div class="cs-status" id="cs-status"></div>' +
                '</div>' +
                '<div class="display-actions">' +
                    '<button class="cs-btn" id="cs-btn" onclick="toggleCrossSection()" disabled>\u2702 Cross Section</button>' +
                    '<button class="cs-btn" id="az-btn" onclick="fetchAzimuthalMean()" disabled>\u27F3 Azim. Mean</button>' +
                    '<button class="cs-btn" id="sq-btn" onclick="fetchShearQuadrants()" disabled>\u25D1 Shear Quads</button>' +
                '</div>' +
            '</div>' +

            // ── RIGHT: Controls panel ──
            '<div class="explorer-controls">' +
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
                        '<optgroup label="Original Swath" id="ep-var-original">' +
                            '<option value="swath_tangential_wind">Tangential Wind</option>' +
                            '<option value="swath_radial_wind">Radial Wind</option>' +
                            '<option value="swath_reflectivity">Reflectivity</option>' +
                            '<option value="swath_wind_speed">Wind Speed</option>' +
                            '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                        '</optgroup>' +
                    '</select>' +
                '</div>' +
                '<div class="explorer-row"><label>Contour Overlay</label>' +
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
                        '<optgroup label="Original Swath" id="ep-overlay-original">' +
                            '<option value="swath_tangential_wind">Tangential Wind</option>' +
                            '<option value="swath_radial_wind">Radial Wind</option>' +
                            '<option value="swath_reflectivity">Reflectivity</option>' +
                            '<option value="swath_wind_speed">Wind Speed</option>' +
                            '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
                        '</optgroup>' +
                    '</select>' +
                    '<div style="display:flex;align-items:center;gap:5px;margin-top:2px;">' +
                        '<label style="font-size:9px;white-space:nowrap;margin:0;">Int:</label>' +
                        '<input type="number" id="ep-contour-int" value="" placeholder="auto" style="width:55px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);">' +
                        '<span style="font-size:9px;color:var(--slate);" id="ep-contour-units"></span>' +
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
                '<div class="explorer-row"><label>Color Range</label>' +
                    '<div style="display:flex;align-items:center;gap:4px;">' +
                        '<input type="number" id="ep-vmin" placeholder="min" step="any" style="width:60px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyColorRange()">' +
                        '<span style="font-size:10px;color:var(--slate);">to</span>' +
                        '<input type="number" id="ep-vmax" placeholder="max" step="any" style="width:60px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyColorRange()">' +
                        '<button onclick="resetColorRange()" title="Reset" style="padding:2px 5px;font-size:9px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);cursor:pointer;color:var(--slate);">\u21BA</button>' +
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
                '<div class="explorer-row" id="az-controls" style="margin-top:6px;"><label>Min. Coverage Threshold</label>' +
                    '<div style="display:flex;align-items:center;gap:6px;">' +
                        '<input type="range" id="az-coverage" min="0" max="100" step="5" value="50" class="az-cov-slider" oninput="document.getElementById(\'az-cov-val\').textContent = this.value+\'%\'">' +
                        '<span style="font-size:11px;font-weight:600;color:var(--cyan);min-width:32px;font-family:\'JetBrains Mono\',monospace;" id="az-cov-val">50%</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    // Set up thumbnail click-to-enlarge and error handling
    var thumbImg = document.getElementById('thumb-img');
    var thumbWrap = document.getElementById('thumb-img-wrap');
    if (thumbImg) {
        thumbImg.onerror = function() {
            // Try raw GitHub URL as fallback
            var fallback = 'https://raw.githubusercontent.com/MichaelFischerWx/michaelfischerwx.github.io/main/TC-RADAR/images/v3m/' + imgPrefix + padded + '.png';
            if (this.src.indexOf('raw.githubusercontent') === -1) {
                this.src = fallback;
            } else {
                // Both failed, hide thumbnail
                document.getElementById('thumbnail-wrap').style.display = 'none';
            }
        };
        thumbWrap.onclick = function() {
            var src = thumbImg.src;
            openImageModal(src, caseData.storm_name + ' \u2013 ' + caseData.datetime);
        };
    }

    // Update variable optgroups for current data type
    _updateExplorerOriginalGroups();

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
var _currentSddc = null;
var _lastSqJson = null;

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
    _lastSqJson = null;
    var variable = document.getElementById('ep-var').value;
    var level_km = document.getElementById('ep-level').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var resultDiv = document.getElementById('ep-result');
    var btn = document.getElementById('ep-btn');
    btn.disabled = true; btn.textContent = 'Generating\u2026';
    // Clear previous az/sq/cs results so stale data from a different variable doesn't persist
    var azResult = document.getElementById('az-result'); if (azResult) azResult.innerHTML = '';
    var sqResult = document.getElementById('sq-result'); if (sqResult) sqResult.innerHTML = '';
    var csResult = document.getElementById('cs-result'); if (csResult) csResult.innerHTML = '';
    var csStatus = document.getElementById('cs-status'); if (csStatus) csStatus.textContent = '';
    if (!_animPlaying) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        resultDiv.innerHTML = '<div class="explorer-status loading">\u23F3 Fetching data from API\u2026 (may take ~30s if service is waking up)</div>';
        var panelInner = document.getElementById('side-panel-inner');
        if (panelInner) panelInner.scrollTop = 0;
    }
    var cacheKey = _activeDataType + '_' + currentCaseIndex + '_' + variable + '_' + level_km + '_' + overlay;
    if (_dataCache[cacheKey]) {
        renderPlotFromJSON(_dataCache[cacheKey], resultDiv);
        btn.disabled = false; btn.textContent = 'Generate Plot';
        if (callback) callback(); return;
    }
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    var url = API_BASE + '/data?case_index=' + currentCaseIndex + '&variable=' + variable + '&level_km=' + level_km + '&data_type=' + _activeDataType + '';
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
    ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen','sq-chart','sq-fullscreen'].forEach(function(id) {
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
    ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen','sq-chart','sq-fullscreen'].forEach(function(id) {
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
        ['plotly-chart','plotly-fullscreen','cs-fullscreen','az-chart','az-fullscreen','sq-chart','sq-fullscreen'].forEach(function(id) {
            var plotDiv = document.getElementById(id);
            if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
            Plotly.restyle(plotDiv, { zmin: [_defaultVmin], zmax: [_defaultVmax] }, [0]);
        });
        if (window._lastPlotlyData) { window._lastPlotlyData.heatmap.zmin = _defaultVmin; window._lastPlotlyData.heatmap.zmax = _defaultVmax; }
    }
}

// ── Composite colormap / color range helpers ─────────────────
var _compDefaultColorscale = null;
var _compDefaultVmin = null;
var _compDefaultVmax = null;

function _getCompColorscale(fallback) {
    var sel = document.getElementById('comp-cmap');
    if (sel && sel.value) { try { return JSON.parse(sel.value); } catch(e) { return sel.value; } }
    return fallback;
}
function _getCompVmin(fallback) { var inp = document.getElementById('comp-vmin'); if (inp && inp.value !== '') return parseFloat(inp.value); return fallback; }
function _getCompVmax(fallback) { var inp = document.getElementById('comp-vmax'); if (inp && inp.value !== '') return parseFloat(inp.value); return fallback; }

function applyCompCmap() {
    var sel = document.getElementById('comp-cmap'); if (!sel) return;
    var cs = sel.value;
    if (!cs && _compDefaultColorscale) cs = _compDefaultColorscale; if (!cs) return;
    var colorscale; try { colorscale = JSON.parse(cs); } catch(e) { colorscale = cs; }
    ['comp-az-chart','comp-sq-chart'].forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        // Restyle all heatmap traces (quadrant view has 4)
        var indices = plotDiv.data.map(function(_,i){return i;});
        var csArr = indices.map(function(){return colorscale;});
        Plotly.restyle(plotDiv, { colorscale: csArr }, indices);
    });
}

function applyCompColorRange() {
    var zmin = _getCompVmin(_compDefaultVmin), zmax = _getCompVmax(_compDefaultVmax);
    if (zmin === null || zmax === null) return;
    ['comp-az-chart','comp-sq-chart'].forEach(function(id) {
        var plotDiv = document.getElementById(id);
        if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
        var indices = plotDiv.data.map(function(_,i){return i;});
        var zminArr = indices.map(function(){return zmin;});
        var zmaxArr = indices.map(function(){return zmax;});
        Plotly.restyle(plotDiv, { zmin: zminArr, zmax: zmaxArr }, indices);
    });
}

function resetCompColorRange() {
    var vminInput = document.getElementById('comp-vmin'), vmaxInput = document.getElementById('comp-vmax');
    if (vminInput) vminInput.value = ''; if (vmaxInput) vmaxInput.value = '';
    if (_compDefaultVmin !== null && _compDefaultVmax !== null) {
        ['comp-az-chart','comp-sq-chart'].forEach(function(id) {
            var plotDiv = document.getElementById(id);
            if (!plotDiv || !plotDiv.data || !plotDiv.data.length) return;
            var indices = plotDiv.data.map(function(_,i){return i;});
            var zminArr = indices.map(function(){return _compDefaultVmin;});
            var zmaxArr = indices.map(function(){return _compDefaultVmax;});
            Plotly.restyle(plotDiv, { zmin: zminArr, zmax: zmaxArr }, indices);
        });
    }
}

// ── Max value helper ─────────────────────────────────────────
function findDataMax(zData, xCoords, yCoords) {
    var maxVal = -Infinity, maxI = 0, maxJ = 0;
    for (var i = 0; i < zData.length; i++) {
        if (!zData[i]) continue;
        for (var j = 0; j < zData[i].length; j++) {
            var v = zData[i][j];
            if (v !== null && v !== undefined && isFinite(v) && v > maxVal) {
                maxVal = v; maxI = i; maxJ = j;
            }
        }
    }
    if (!isFinite(maxVal)) return null;
    return { value: maxVal, x: xCoords[maxJ], y: yCoords[maxI] };
}

function findDataMin(zData, xCoords, yCoords) {
    var minVal = Infinity, minI = 0, minJ = 0;
    for (var i = 0; i < zData.length; i++) {
        if (!zData[i]) continue;
        for (var j = 0; j < zData[i].length; j++) {
            var v = zData[i][j];
            if (v !== null && v !== undefined && isFinite(v) && v < minVal) {
                minVal = v; minI = i; minJ = j;
            }
        }
    }
    if (!isFinite(minVal)) return null;
    return { value: minVal, x: xCoords[minJ], y: yCoords[minI] };
}

function isWindVariable(varName) {
    return varName && varName.toLowerCase().indexOf('wind') !== -1;
}

function buildMaxMarkerTrace(maxInfo, units) {
    if (!maxInfo) return null;
    return {
        x: [maxInfo.x], y: [maxInfo.y], type: 'scatter', mode: 'markers+text',
        marker: { symbol: 'x', size: 10, color: 'white', line: { color: 'rgba(0,0,0,0.6)', width: 1.5 } },
        text: [''], textposition: 'top right',
        textfont: { color: 'white', size: 9 },
        hoverinfo: 'text',
        hovertext: ['Max: ' + maxInfo.value.toFixed(2) + ' ' + units + '\n@ (' + maxInfo.x.toFixed(0) + ', ' + maxInfo.y.toFixed(0) + ')'],
        showlegend: false
    };
}

function buildMaxAnnotation(maxInfo, units, xLabel, yLabel, fontSize) {
    if (!maxInfo) return null;
    var fs = fontSize || 9;
    return {
        text: '<b>Max:</b> ' + maxInfo.value.toFixed(2) + ' ' + units +
              '  @  ' + xLabel + '=' + maxInfo.x.toFixed(0) + ', ' + yLabel + '=' + maxInfo.y.toFixed(0),
        xref: 'paper', yref: 'paper', x: 0.01, y: -0.01,
        xanchor: 'left', yanchor: 'top',
        showarrow: false,
        font: { color: '#d1d5db', size: fs, family: 'JetBrains Mono, monospace' },
        bgcolor: 'rgba(10,22,40,0.8)',
        borderpad: 3,
        bordercolor: 'rgba(255,255,255,0.15)',
        borderwidth: 1
    };
}

function renderPlotFromJSON(json, resultDiv) {
    // Hide thumbnail, show plot in its place
    var thumbWrap = document.getElementById('thumbnail-wrap');
    if (thumbWrap) thumbWrap.style.display = 'none';

    resultDiv.innerHTML = '<div style="position:relative;"><div id="plotly-chart" style="width:100%;height:360px;border-radius:6px;overflow:hidden;"></div><button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button></div><div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover for values \u00b7 scroll to zoom \u00b7 drag to pan \u00b7 \u26F6 expand</div>';

    // Scroll panel to top so plot is visible
    var panelInner = document.getElementById('side-panel-inner');
    if (panelInner) panelInner.scrollTop = 0;

    var zData = json.data, x = json.x, y = json.y, varInfo = json.variable, meta = json.case_meta;
    _currentSddc = (meta.sddc !== undefined && meta.sddc !== null && meta.sddc !== 9999) ? meta.sddc : null;
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

    // Max value marker + annotation
    var maxInfo = findDataMax(zData, x, y);
    var maxTraces = [];
    if (maxInfo) {
        var maxAnnot = buildMaxAnnotation(maxInfo, varInfo.units, 'X', 'Y', 9);
        if (maxAnnot) {
            smallLayout.annotations = (smallLayout.annotations || []).concat([maxAnnot]);
            baseLayout.annotations = (baseLayout.annotations || []).concat([maxAnnot]);
        }
        if (isWindVariable((document.getElementById('ep-var') || {}).value || '')) {
            var maxMarker = buildMaxMarkerTrace(maxInfo, varInfo.units);
            if (maxMarker) maxTraces.push(maxMarker);
        }
    }

    // Shear vector inset (small panel only; fullscreen builds its own in openPlotModal)
    var shearInset = buildShearInset(_currentSddc, false);
    if (shearInset.shapes.length) {
        smallLayout.shapes = (smallLayout.shapes || []).concat(shearInset.shapes);
    }
    if (shearInset.annotations.length) {
        smallLayout.annotations = (smallLayout.annotations || []).concat(shearInset.annotations);
    }

    Plotly.newPlot('plotly-chart', [heatmap].concat(overlayTraces).concat(maxTraces), smallLayout, config);
    window._lastPlotlyData = { heatmap: heatmap, overlayTraces: overlayTraces, maxTraces: maxTraces, baseLayout: baseLayout, title: title, config: config };
    var csBtn = document.getElementById('cs-btn'); if (csBtn) csBtn.disabled = false;
    var azBtn = document.getElementById('az-btn'); if (azBtn) azBtn.disabled = false;
    var sqBtn = document.getElementById('sq-btn'); if (sqBtn) sqBtn.disabled = false;
    document.getElementById('plotly-chart').on('plotly_click', handlePlotClick);

    // Auto-scroll the side panel to show the plot (skip during animation)
    if (!_animPlaying) {
        setTimeout(function() {
            var chartEl = document.getElementById('plotly-chart');
            if (chartEl) chartEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 150);
    }
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
    var url = API_BASE + '/cross_section?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&x0=' + a.x + '&y0=' + a.y + '&x1=' + b.x + '&y1=' + b.y + '&n_points=150';
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

    // Max value marker + annotation for cross-section
    var csMaxInfo = findDataMax(csData, distance_km, height_km);
    var csMaxTraces = [];
    if (csMaxInfo) {
        var csMaxAnnot = buildMaxAnnotation(csMaxInfo, varInfo.units, 'Dist', 'Z', fullsize ? 10 : 8);
        if (csMaxAnnot) layout.annotations = (layout.annotations || []).concat([csMaxAnnot]);
        if (isWindVariable((document.getElementById('ep-var') || {}).value || '')) {
            var csMaxMarker = buildMaxMarkerTrace(csMaxInfo, varInfo.units);
            if (csMaxMarker) csMaxTraces.push(csMaxMarker);
        }
    }

    // Shear vector inset for cross-section
    var csShearInset = buildShearInsetCS(_currentSddc, fullsize);
    if (csShearInset.annotations.length) layout.annotations = (layout.annotations || []).concat(csShearInset.annotations);
    if (csShearInset.shapes.length) layout.shapes = (layout.shapes || []).concat(csShearInset.shapes);

    Plotly.newPlot(targetId, [heatmap].concat(csOverlayTraces).concat(csMaxTraces), layout, { responsive: true, displayModeBar: fullsize, displaylogo: false, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'] });
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
    var url = API_BASE + '/azimuthal_mean?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&coverage_min=' + coverage;
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
    if (meta.sddc !== undefined && meta.sddc !== null && meta.sddc !== 9999) _currentSddc = meta.sddc;
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

    // Max value marker + annotation for azimuthal mean
    var azMaxInfo = findDataMax(azData, radius_km, height_km);
    var azMaxTraces = [];
    if (azMaxInfo) {
        var azMaxAnnot = buildMaxAnnotation(azMaxInfo, varInfo.units, 'R', 'Z', fullsize ? 10 : 8);
        if (azMaxAnnot) layout.annotations = (layout.annotations || []).concat([azMaxAnnot]);
        if (isWindVariable((document.getElementById('ep-var') || {}).value || '')) {
            var azMaxMarker = buildMaxMarkerTrace(azMaxInfo, varInfo.units);
            if (azMaxMarker) azMaxTraces.push(azMaxMarker);
        }
    }

    // Shear vector inset for azimuthal mean
    var azShearInset = buildShearInsetCS(_currentSddc, fullsize);
    if (azShearInset.annotations.length) layout.annotations = (layout.annotations || []).concat(azShearInset.annotations);
    if (azShearInset.shapes.length) layout.shapes = (layout.shapes || []).concat(azShearInset.shapes);

    if (!fullsize) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="az-chart" style="width:100%;height:340px;border-radius:6px;overflow:hidden;"></div><button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button></div><div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover \u00b7 zoom \u00b7 pan \u00b7 \u26F6 expand</div>';
        Plotly.newPlot('az-chart', [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, { responsive:true,displayModeBar:false,displaylogo:false });
        var panelInner = document.getElementById('side-panel-inner');
        if (panelInner) panelInner.scrollTop = 0;
    } else {
        Plotly.newPlot(targetId, [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, { responsive:true,displayModeBar:true,displaylogo:false,modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
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

// ── Shear vector inset ──────────────────────────────────────────
function buildShearInset(sddc, isFullsize) {
    if (sddc === null || sddc === undefined || sddc === 9999) return { shapes: [], annotations: [] };
    // Convert SDDC (met heading: 0=N,90=E) to math angle (CCW from east)
    var theta = (90 - sddc) * Math.PI / 180;
    // Inset center position (paper coords) - top-left corner
    var cx = isFullsize ? 0.08 : 0.10;
    var cy = isFullsize ? 0.92 : 0.90;
    var r = isFullsize ? 0.045 : 0.055;
    var arrowLen = r * 0.82;
    var dx = arrowLen * Math.cos(theta);
    var dy = arrowLen * Math.sin(theta);
    // Aspect ratio correction: paper coords are not square, estimate from typical plots
    var aspect = 1.0; // for square axes with scaleanchor this is ~1
    var shapes = [
        // Background circle
        { type:'circle', xref:'paper', yref:'paper',
          x0: cx-r, y0: cy-r, x1: cx+r, y1: cy+r,
          fillcolor:'rgba(10,22,40,0.85)', line:{ color:'rgba(255,255,255,0.25)', width:1 } },
        // Shear arrow shaft
        { type:'line', xref:'paper', yref:'paper',
          x0: cx - dx*0.3, y0: cy - dy*0.3, x1: cx + dx, y1: cy + dy,
          line:{ color:'#f59e0b', width: isFullsize?2.5:2 } }
    ];
    // Arrowhead using two short lines
    var headLen = arrowLen * 0.35;
    var headAngle = 25 * Math.PI / 180;
    var ha1 = theta + Math.PI - headAngle;
    var ha2 = theta + Math.PI + headAngle;
    var tipX = cx + dx, tipY = cy + dy;
    shapes.push({ type:'line', xref:'paper', yref:'paper',
        x0: tipX, y0: tipY, x1: tipX + headLen*Math.cos(ha1), y1: tipY + headLen*Math.sin(ha1),
        line:{ color:'#f59e0b', width: isFullsize?2.5:2 } });
    shapes.push({ type:'line', xref:'paper', yref:'paper',
        x0: tipX, y0: tipY, x1: tipX + headLen*Math.cos(ha2), y1: tipY + headLen*Math.sin(ha2),
        line:{ color:'#f59e0b', width: isFullsize?2.5:2 } });
    // Small dot at center
    var dotR = r * 0.08;
    shapes.push({ type:'circle', xref:'paper', yref:'paper',
        x0: cx-dotR, y0: cy-dotR, x1: cx+dotR, y1: cy+dotR,
        fillcolor:'rgba(255,255,255,0.5)', line:{ width:0 } });
    var annotations = [
        { text:'<b>SHR</b>', xref:'paper', yref:'paper', x: cx, y: cy + r + (isFullsize?0.025:0.03),
          showarrow:false, font:{ color:'#f59e0b', size: isFullsize?10:8, family:'JetBrains Mono, monospace' },
          bgcolor:'rgba(10,22,40,0.7)', borderpad:1 },
        { text: sddc.toFixed(0) + '\u00b0', xref:'paper', yref:'paper', x: cx, y: cy - r - (isFullsize?0.02:0.025),
          showarrow:false, font:{ color:'rgba(245,158,11,0.7)', size: isFullsize?8:7, family:'JetBrains Mono, monospace' } }
    ];
    return { shapes: shapes, annotations: annotations };
}

// Build shear inset for cross-section (simpler: just show direction label)
function buildShearInsetCS(sddc, isFullsize) {
    if (sddc === null || sddc === undefined || sddc === 9999) return { shapes: [], annotations: [] };
    var annotations = [
        { text:'<b>SHR: ' + sddc.toFixed(0) + '\u00b0</b>',
          xref:'paper', yref:'paper', x: 0.01, y: 1.0,
          xanchor:'left', yanchor:'bottom', showarrow:false,
          font:{ color:'#f59e0b', size: isFullsize?10:8, family:'JetBrains Mono, monospace' },
          bgcolor:'rgba(10,22,40,0.8)', borderpad:2, bordercolor:'rgba(245,158,11,0.3)', borderwidth:1 }
    ];
    return { shapes: [], annotations: annotations };
}

// ── Shear-Relative Quadrant Means ───────────────────────────────
function fetchShearQuadrants() {
    if (currentCaseIndex === null) return;
    var variable = document.getElementById('ep-var').value;
    var overlay = (document.getElementById('ep-overlay') || {}).value || '';
    var covSlider = document.getElementById('az-coverage');
    var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
    var resultDiv = document.getElementById('sq-result'), btn = document.getElementById('sq-btn');
    resultDiv.innerHTML = '<div class="explorer-status loading">\u23F3 Computing shear-relative quadrant means\u2026</div>';
    btn.disabled = true; btn.textContent = '\u25D1 Computing\u2026';
    var url = API_BASE + '/quadrant_mean?case_index=' + currentCaseIndex + '&variable=' + variable + '&data_type=' + _activeDataType + '&coverage_min=' + coverage;
    if (overlay && overlay !== 'none') url += '&overlay=' + overlay;
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 90000);
    fetch(url, { signal: controller.signal })
        .then(function(r) { if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
        .then(function(json) {
            _lastSqJson = json;
            if (json.case_meta && json.case_meta.sddc !== undefined) _currentSddc = (json.case_meta.sddc !== 9999) ? json.case_meta.sddc : null;
            resultDiv.innerHTML = '<div class="explorer-status" style="color:#10b981;">\u2713 Shear quadrants ready \u2014 opening expanded view</div>';
            openPlotModal();
        })
        .catch(function(err) { resultDiv.innerHTML = '<div class="explorer-status error">\u26A0\uFE0F ' + (err.name === 'AbortError' ? 'Request timed out (90s).' : err.message) + '</div>'; })
        .finally(function() { clearTimeout(timeout); btn.disabled = false; btn.textContent = '\u25D1 Shear Quads'; });
}

function renderQuadrantMeansInto(targetId, json, fullsize) {
    var el = document.getElementById(targetId); if (!el) return;
    var quads = json.quadrant_means; // { DSL: {data:...}, DSR: ..., USL: ..., USR: ... }
    var radius_km = json.radius_km, height_km = json.height_km, varInfo = json.variable, meta = json.case_meta;
    var sddc = (meta.sddc !== undefined && meta.sddc !== 9999) ? meta.sddc : null;
    var fontSize = fullsize ? { title:14,axis:11,tick:10,cbar:11,cbarTick:10,hover:12,panel:12 } : { title:11,axis:9,tick:8,cbar:9,cbarTick:8,hover:10,panel:10 };

    var csColorscale = varInfo.colorscale;
    var cmapSel = document.getElementById('ep-cmap');
    if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch(e) { csColorscale = cmapSel.value; } }
    var av = _getActiveVmin(), avx = _getActiveVmax();
    var zmin = av !== null ? av : varInfo.vmin;
    var zmax = avx !== null ? avx : varInfo.vmax;

    // 4-panel layout: USL(top-left), DSL(top-right), USR(bottom-left), DSR(bottom-right)
    // This orients as if shear is westerly: downshear=right, left-of-shear=top
    var panelOrder = [
        { key: 'USL', label: 'Upshear Left', row: 0, col: 0, xaxis: 'x', yaxis: 'y' },
        { key: 'DSL', label: 'Downshear Left', row: 0, col: 1, xaxis: 'x2', yaxis: 'y2' },
        { key: 'USR', label: 'Upshear Right', row: 1, col: 0, xaxis: 'x3', yaxis: 'y3' },
        { key: 'DSR', label: 'Downshear Right', row: 1, col: 1, xaxis: 'x4', yaxis: 'y4' }
    ];

    var traces = [];
    var annotations = [];
    var shapes = [];

    // Panel spacing
    var gap = fullsize ? 0.08 : 0.10;
    var cbarW = 0.04;
    var leftM = 0.06, rightM = 0.02 + cbarW + 0.02;
    var topM = fullsize ? 0.10 : 0.12;
    var botM = 0.06;
    var pw = (1 - leftM - rightM - gap) / 2;
    var ph = (1 - topM - botM - gap) / 2;

    // Quadrant panel colors for subtle border highlighting
    var quadColors = { DSL: '#f59e0b', DSR: '#f59e0b', USL: '#60a5fa', USR: '#60a5fa' };

    panelOrder.forEach(function(p, i) {
        var qData = quads[p.key];
        if (!qData || !qData.data) return;
        var x0 = leftM + p.col * (pw + gap);
        var x1 = x0 + pw;
        var y0 = botM + (1 - p.row) * (ph + gap); // row 0 = top
        var y1 = y0 + ph;
        // Adjust: row 0 should be higher y
        var yBottom = 1 - topM - (p.row + 1) * ph - p.row * gap;
        var yTop = 1 - topM - p.row * ph - p.row * gap;

        var axSuffix = i === 0 ? '' : String(i + 1);
        var showCbar = (i === 1); // only show colorbar on top-right panel

        traces.push({
            z: qData.data, x: radius_km, y: height_km,
            type: 'heatmap', colorscale: csColorscale, zmin: zmin, zmax: zmax,
            xaxis: 'x' + axSuffix, yaxis: 'y' + axSuffix,
            showscale: showCbar,
            colorbar: showCbar ? {
                title: { text: varInfo.units, font: { color: '#ccc', size: fontSize.cbar } },
                tickfont: { color: '#ccc', size: fontSize.cbarTick },
                thickness: fullsize ? 14 : 10, len: 0.85,
                x: 1.02, y: 0.5
            } : undefined,
            hovertemplate: '<b>' + p.label + '</b><br>' + varInfo.display_name + ': %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false
        });

        // Panel title annotation
        annotations.push({
            text: '<b>' + p.label + '</b>',
            xref: 'paper', yref: 'paper',
            x: (x0 + x1) / 2, y: yTop + 0.005,
            xanchor: 'center', yanchor: 'bottom', showarrow: false,
            font: { color: quadColors[p.key] || '#ccc', size: fontSize.panel, family: 'JetBrains Mono, monospace' },
            bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2
        });

        // RMW line
        if (meta.rmw_km && !isNaN(meta.rmw_km)) {
            shapes.push({ type:'line', xref: 'x' + axSuffix, yref: 'y' + axSuffix,
                x0: meta.rmw_km, x1: meta.rmw_km, y0: height_km[0], y1: height_km[height_km.length-1],
                line:{ color:'white', width:1, dash:'dash' } });
        }
    });

    // Build axes
    var plotBg = '#0a1628';
    var layout = {
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        margin: fullsize ? { l:55, r:70, t:70, b:50 } : { l:45, r:55, t:62, b:42 },
        showlegend: false,
        annotations: annotations,
        shapes: shapes,
        hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: fontSize.hover } }
    };

    // Define axes for each panel
    var axConfigs = [
        { x0: leftM, x1: leftM + pw, y0: 1-topM-ph, y1: 1-topM },           // top-left (USL)
        { x0: leftM+pw+gap, x1: leftM+2*pw+gap, y0: 1-topM-ph, y1: 1-topM }, // top-right (DSL)
        { x0: leftM, x1: leftM+pw, y0: botM, y1: botM+ph },                    // bottom-left (USR)
        { x0: leftM+pw+gap, x1: leftM+2*pw+gap, y0: botM, y1: botM+ph }        // bottom-right (DSR)
    ];

    panelOrder.forEach(function(p, i) {
        var axSuffix = i === 0 ? '' : String(i + 1);
        var ac = axConfigs[i];
        var showXLabel = (p.row === 1); // only bottom row
        var showYLabel = (p.col === 0); // only left column
        layout['xaxis' + axSuffix] = {
            domain: [ac.x0, ac.x1],
            title: showXLabel ? { text: 'Radius (km)', font: { color: '#aaa', size: fontSize.axis } } : undefined,
            tickfont: { color: '#aaa', size: fontSize.tick },
            gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
            anchor: 'y' + axSuffix
        };
        layout['yaxis' + axSuffix] = {
            domain: [ac.y0, ac.y1],
            title: showYLabel ? { text: 'Height (km)', font: { color: '#aaa', size: fontSize.axis } } : undefined,
            tickfont: { color: '#aaa', size: fontSize.tick },
            gridcolor: 'rgba(255,255,255,0.04)', zeroline: false,
            anchor: 'x' + axSuffix
        };
    });

    // Main title
    var vmaxStr = meta.vmax_kt ? ' | Vmax = ' + meta.vmax_kt + ' kt' : '';
    var shearStr = sddc !== null ? ' | Shear: ' + sddc.toFixed(0) + '\u00b0' : '';
    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    layout.title = {
        text: meta.storm_name + ' | ' + meta.datetime + vmaxStr + shearStr + '<br>Shear-Relative Quadrant Mean: ' + varInfo.display_name + ' (\u2265' + covPct + '% cov.)' + overlayLabel,
        font: { color: '#e5e7eb', size: fontSize.title }, y: 0.99, x: 0.5, xanchor: 'center'
    };

    // Add shear vector inset between the 4 panels (center)
    if (sddc !== null) {
        var insetCx = leftM + pw + gap/2;
        var insetCy = botM + ph + gap/2;
        var insetR = Math.min(gap, 0.06) * 0.55;
        var theta = (90 - sddc) * Math.PI / 180;
        var arrowLen = insetR * 0.8;
        var adx = arrowLen * Math.cos(theta);
        var ady = arrowLen * Math.sin(theta);
        // Background circle
        shapes.push({ type:'circle', xref:'paper', yref:'paper',
            x0:insetCx-insetR, y0:insetCy-insetR, x1:insetCx+insetR, y1:insetCy+insetR,
            fillcolor:'rgba(10,22,40,0.9)', line:{color:'rgba(245,158,11,0.4)',width:1.5} });
        // Arrow shaft
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0:insetCx - adx*0.3, y0:insetCy - ady*0.3, x1:insetCx + adx, y1:insetCy + ady,
            line:{color:'#f59e0b',width:2.5} });
        // Arrowhead
        var headLen2 = arrowLen * 0.35, headAngle2 = 25 * Math.PI / 180;
        var tipX2 = insetCx + adx, tipY2 = insetCy + ady;
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0:tipX2, y0:tipY2, x1:tipX2+headLen2*Math.cos(theta+Math.PI-headAngle2), y1:tipY2+headLen2*Math.sin(theta+Math.PI-headAngle2),
            line:{color:'#f59e0b',width:2.5} });
        shapes.push({ type:'line', xref:'paper', yref:'paper',
            x0:tipX2, y0:tipY2, x1:tipX2+headLen2*Math.cos(theta+Math.PI+headAngle2), y1:tipY2+headLen2*Math.sin(theta+Math.PI+headAngle2),
            line:{color:'#f59e0b',width:2.5} });
        // "DS" label at arrowhead
        annotations.push({ text:'DS', xref:'paper', yref:'paper',
            x:insetCx + adx*1.6, y:insetCy + ady*1.6,
            showarrow:false, font:{color:'#f59e0b',size:fullsize?9:7,family:'JetBrains Mono,monospace'} });
    }

    // Add overlay contours for each quadrant if present
    if (json.overlay && json.overlay.quadrant_means) {
        var intInput = document.getElementById('ep-contour-int');
        var interval = intInput ? parseFloat(intInput.value) : NaN;
        panelOrder.forEach(function(p, i) {
            var ovQ = json.overlay.quadrant_means[p.key];
            if (!ovQ || !ovQ.data) return;
            if (isNaN(interval) || interval <= 0) {
                var flat = ovQ.data.flat().filter(function(v){return v!==null&&!isNaN(v);});
                if (flat.length === 0) return;
                var mn=Infinity,mx=-Infinity;
                for(var k=0;k<flat.length;k++){if(flat[k]<mn)mn=flat[k];if(flat[k]>mx)mx=flat[k];}
                interval=parseFloat(((mx-mn)/10).toPrecision(1));
                if(!isFinite(interval)||interval<=0) interval=(mx-mn)/10||1;
            }
            var axSuffix = i === 0 ? '' : String(i+1);
            var baseContour = { z:ovQ.data, x:radius_km, y:height_km, type:'contour', xaxis:'x'+axSuffix, yaxis:'y'+axSuffix, showscale:false, hoverongaps:false, contours:{coloring:'none',showlabels:true,labelfont:{size:8,color:'rgba(255,255,255,0.7)'}} };
            if (json.overlay.vmax > interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:interval,end:json.overlay.vmax,size:interval}),line:{color:'rgba(0,0,0,0.6)',width:1,dash:'solid'},showlegend:false}));
            if (json.overlay.vmin < -interval) traces.push(Object.assign({},baseContour,{contours:Object.assign({},baseContour.contours,{start:json.overlay.vmin,end:-interval,size:interval}),line:{color:'rgba(0,0,0,0.6)',width:1,dash:'dash'},showlegend:false}));
        });
    }

    layout.shapes = shapes;
    layout.annotations = annotations;

    if (!fullsize) {
        var thumbWrap = document.getElementById('thumbnail-wrap');
        if (thumbWrap) thumbWrap.style.display = 'none';
        el.innerHTML = '<div style="position:relative;"><div id="sq-chart" style="width:100%;height:400px;border-radius:6px;overflow:hidden;"></div><button onclick="openPlotModal()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">\u26F6</button></div><div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover \u00b7 zoom \u00b7 pan \u00b7 \u26F6 expand</div>';
        Plotly.newPlot('sq-chart', traces, layout, { responsive:true, displayModeBar:false, displaylogo:false });
        var panelInner = document.getElementById('side-panel-inner');
        if (panelInner) panelInner.scrollTop = 0;
    } else {
        Plotly.newPlot(targetId, traces, layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
    }
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
    var shearDir = (caseData.sddc !== null && caseData.sddc !== undefined && caseData.sddc !== 9999) ? caseData.sddc.toFixed(0) + '\u00b0' : 'N/A';
    var category = getIntensityCategory(caseData.vmax_kt);
    var catColor = getIntensityColor(caseData.vmax_kt);
    var idx = caseData.case_index;
    var nSwathsRow = (caseData.number_of_swaths !== null && caseData.number_of_swaths !== undefined) ?
        '<div class="popup-row"><span class="popup-label">Swaths:</span><span class="popup-value">' + caseData.number_of_swaths + '</span></div>' : '';
    var dtBadge = _activeDataType === 'merge' ? '<span style="font-size:9px;background:#4f46e5;color:#fff;padding:1px 5px;border-radius:3px;margin-left:6px;">MERGE</span>' : '';
    return '<div class="popup-header"><div class="popup-storm-name">' + caseData.storm_name + dtBadge + '</div><div class="popup-mission">' + caseData.mission_id + '</div></div>' +
        '<div class="popup-row"><span class="popup-label">Date/Time:</span><span class="popup-value">' + caseData.datetime + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Intensity:</span><span class="popup-value"><span class="intensity-badge" style="background:' + catColor + '">' + category + '</span> ' + intensity + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">24-h Change:</span><span class="popup-value">' + vmaxChange + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Min Pressure:</span><span class="popup-value">' + pressure + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">RMW:</span><span class="popup-value">' + rmw + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Tilt Magnitude:</span><span class="popup-value">' + tiltMag + '</span></div>' +
        '<div class="popup-row"><span class="popup-label">Shear Dir:</span><span class="popup-value">' + shearDir + '</span></div>' +
        nSwathsRow +
        '<div class="popup-row"><span class="popup-label">Location:</span><span class="popup-value">' + Math.abs(caseData.latitude).toFixed(2) + '\u00b0' + (caseData.latitude>=0?'N':'S') + ', ' + Math.abs(caseData.longitude).toFixed(2) + '\u00b0' + (caseData.longitude<0?'W':'E') + '</span></div>' +
        '<button class="popup-explore-btn" onclick="openSidePanelById(' + idx + ')">\uD83D\uDD2C View Radar & Explore Data \u2192</button>';
}

function openSidePanelById(idx) { var d = _getActiveData(); if (!d) return; var caseData = d.cases.find(function(c) { return c.case_index === idx; }); if (caseData) openSidePanel(caseData); }

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
    if (!markers || !_getActiveData()) return; markers.clearLayers(); var n = 0;
    _getActiveData().cases.forEach(function(c) { if (passesFilters(c)) { var m = allMarkers.find(function(m) { return m.caseIndex === c.case_index; }); if (m) { markers.addLayer(m.marker); n++; } } });
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
var mergeData = null;
fetch('tc_radar_metadata_merge.json')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) { mergeData = data; console.log('Merge metadata loaded: ' + data.total_cases + ' cases'); })
    .catch(function(err) { console.warn('Merge metadata not available: ' + err.message); });

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

// ── Data-type toggle (Swath / Merge) ──────────────────────────
function _injectDataTypeToggle() {
    var toolbar = document.querySelector('.map-toolbar');
    if (!toolbar) return;
    var grp = document.createElement('div');
    grp.className = 'toolbar-group';
    grp.innerHTML =
        '<span class="toolbar-label">Data</span>' +
        '<select id="map-data-type" class="toolbar-select" style="min-width:100px;" onchange="switchDataType(this.value)">' +
            '<option value="swath">Swath</option>' +
            '<option value="merge">Merge</option>' +
        '</select>';
    toolbar.insertBefore(grp, toolbar.firstChild);
    // add a separator after
    var sep = document.createElement('div');
    sep.className = 'toolbar-sep';
    grp.parentNode.insertBefore(sep, grp.nextSibling);
}
_injectDataTypeToggle();

function switchDataType(dt) {
    if (dt === _activeDataType) return;
    var src = dt === 'merge' ? mergeData : allData;
    if (!src) {
        alert(dt === 'merge' ? 'Merge metadata not loaded yet.' : 'Swath metadata not loaded yet.');
        document.getElementById('map-data-type').value = _activeDataType;
        return;
    }
    _activeDataType = dt;
    closeSidePanel();

    // Update hero stats
    document.getElementById('total-cases').textContent = src.total_cases.toLocaleString();
    document.getElementById('total-count').textContent = src.total_cases.toLocaleString();
    var storms = new Set(src.cases.map(function(c) { return c.storm_name; }));
    document.getElementById('unique-storms').textContent = storms.size.toLocaleString();
    var years = src.cases.map(function(c) { return c.year; });
    document.getElementById('year-range').textContent = Math.min.apply(null, years) + '\u2013' + Math.max.apply(null, years);

    // Rebuild storm dropdown
    var stormSelect = document.getElementById('storm-select');
    stormSelect.innerHTML = '<option value="">All Storms</option>';
    Array.from(storms).sort().forEach(function(s) { var o = document.createElement('option'); o.value = s; o.textContent = s; stormSelect.appendChild(o); });

    // Reset case dropdown
    document.getElementById('case-select').innerHTML = '<option value="">\u2190 Select a storm first</option>';
    document.getElementById('case-select').disabled = true;
    document.getElementById('explore-btn').disabled = true;
    filters.stormName = 'all';

    // Rebuild markers
    markers.clearLayers();
    allMarkers = [];
    src.cases.forEach(function(caseData) {
        var color = getIntensityColor(caseData.vmax_kt);
        var icon = L.divIcon({ className:'custom-div-icon', html:'<div class="custom-marker" style="background-color:'+color+';width:12px;height:12px;box-shadow:0 0 6px '+color+'40;"></div>', iconSize:[12,12], iconAnchor:[6,6] });
        var marker = L.marker([caseData.latitude, caseData.longitude], { icon: icon });
        marker.bindPopup(createPopupContent(caseData), { maxWidth:320,minWidth:260,autoPan:true,autoPanPadding:[50,50],keepInView:true,closeButton:true,closeOnEscapeKey:true });
        allMarkers.push({ caseIndex: caseData.case_index, marker: marker });
        markers.addLayer(marker);
    });
    updateMarkers();
}

// Update explorer panel Original optgroups when data type changes
function _updateExplorerOriginalGroups() {
    var isMerge = _activeDataType === 'merge';
    var label = isMerge ? 'Original Merged' : 'Original Swath';
    var options = isMerge ?
        '<option value="merged_tangential_wind">Tangential Wind</option>' +
        '<option value="merged_radial_wind">Radial Wind</option>' +
        '<option value="merged_reflectivity">Reflectivity</option>' +
        '<option value="merged_wind_speed">Wind Speed</option>' +
        '<option value="merged_upward_air_velocity">Vertical Velocity</option>' +
        '<option value="merged_relative_vorticity">Relative Vorticity</option>' +
        '<option value="merged_divergence">Divergence</option>'
        :
        '<option value="swath_tangential_wind">Tangential Wind</option>' +
        '<option value="swath_radial_wind">Radial Wind</option>' +
        '<option value="swath_reflectivity">Reflectivity</option>' +
        '<option value="swath_wind_speed">Wind Speed</option>' +
        '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>';
    ['ep-var-original','ep-overlay-original'].forEach(function(id) {
        var og = document.getElementById(id);
        if (og) { og.label = label; og.innerHTML = options; }
    });
}

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
    // Dynamically create sq-fullscreen and sq-full-divider if they don't exist
    var sqFull = document.getElementById('sq-fullscreen');
    var sqDivider = document.getElementById('sq-full-divider');
    if (!sqFull) {
        sqDivider = document.createElement('div'); sqDivider.id = 'sq-full-divider';
        sqDivider.style.cssText = 'height:1px;background:rgba(255,255,255,0.1);margin:8px 0;display:none;';
        sqFull = document.createElement('div'); sqFull.id = 'sq-fullscreen';
        sqFull.style.cssText = 'width:100%;display:none;';
        var container = azFull ? azFull.parentElement : csFull.parentElement;
        container.appendChild(sqDivider); container.appendChild(sqFull);
    }
    modal.classList.add('active'); document.body.style.overflow = 'hidden';
    var hasCrossSection = !!csJson, hasAzMean = !!_lastAzJson, hasShearQuads = !!_lastSqJson;
    var hasSub = hasCrossSection || hasAzMean || hasShearQuads;
    if (hasSub) box.classList.add('split'); else box.classList.remove('split');
    csFull.style.display = hasCrossSection?'block':'none'; csDivider.style.display = hasCrossSection?'block':'none';
    azFull.style.display = hasAzMean?'block':'none'; azDivider.style.display = hasAzMean?'block':'none';
    sqFull.style.display = hasShearQuads?'block':'none'; sqDivider.style.display = hasShearQuads?'block':'none';
    var subCount = (hasCrossSection?1:0)+(hasAzMean?1:0)+(hasShearQuads?1:0);
    // Adjust heights based on what's being shown
    if (hasShearQuads && subCount === 1) {
        // Shear quads only: give it most of the space (it's a 4-panel plot)
        document.getElementById('plotly-fullscreen').style.height = '45%';
        sqFull.style.height = '52%';
    } else if (subCount === 0) {
        document.getElementById('plotly-fullscreen').style.height = '100%';
    } else if (subCount === 1) {
        document.getElementById('plotly-fullscreen').style.height = '55%';
        if (hasShearQuads) sqFull.style.height = '42%';
    } else if (subCount === 2) {
        document.getElementById('plotly-fullscreen').style.height = '40%';
        if (hasShearQuads) sqFull.style.height = '38%';
    } else {
        document.getElementById('plotly-fullscreen').style.height = '30%';
        if (hasShearQuads) sqFull.style.height = '32%';
    }

    var d = window._lastPlotlyData;
    var fullLayout = Object.assign({}, d.baseLayout, { title: { text: d.title, font: { color: '#e5e7eb', size: 15 }, y: 0.97, x: 0.5, xanchor: 'center' }, margin: { l:65,r:30,t:d.overlayTraces&&d.overlayTraces.length?76:60,b:55 }, xaxis: Object.assign({}, d.baseLayout.xaxis, { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 13 } }, tickfont: { color: '#aaa', size: 11 } }), yaxis: Object.assign({}, d.baseLayout.yaxis, { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 13 } }, tickfont: { color: '#aaa', size: 11 } }) });
    // Scale up annotations for fullscreen
    if (fullLayout.annotations) {
        fullLayout.annotations = fullLayout.annotations.map(function(a) {
            return Object.assign({}, a, { font: Object.assign({}, a.font, { size: 11 }) });
        });
    }
    // Add fullscreen-scaled shear inset (baseLayout has no shear shapes)
    var fsShearInset = buildShearInset(_currentSddc, true);
    if (fsShearInset.shapes.length) fullLayout.shapes = (fullLayout.shapes || []).concat(fsShearInset.shapes);
    if (fsShearInset.annotations.length) fullLayout.annotations = (fullLayout.annotations || []).concat(fsShearInset.annotations);
    var fullHeatmap = Object.assign({}, d.heatmap, { colorbar: Object.assign({}, d.heatmap.colorbar, { title: { text: d.heatmap.colorbar.title.text, font: { color: '#ccc', size: 13 } }, tickfont: { color: '#ccc', size: 11 }, thickness: 16, len: 0.85 }) });
    Plotly.newPlot('plotly-fullscreen', [fullHeatmap].concat(d.overlayTraces||[]).concat(d.maxTraces||[]), fullLayout, d.config);
    if (hasCrossSection) renderCrossSectionInto('cs-fullscreen', csJson, true);
    if (hasAzMean) renderAzimuthalMeanInto('az-fullscreen', _lastAzJson, true);
    if (hasShearQuads) renderQuadrantMeansInto('sq-fullscreen', _lastSqJson, true);
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
    var sqFull = document.getElementById('sq-fullscreen'); if (sqFull) { Plotly.purge('sq-fullscreen'); sqFull.style.display='none'; }
    var sqDiv = document.getElementById('sq-full-divider'); if (sqDiv) sqDiv.style.display='none';
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


// ═══════════════════════════════════════════════════════════════
// ── COMPOSITE ANALYSIS PANEL ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════

var _compositePanel = null;
var _compositeCountTimeout = null;

function _varOptionsHTML(idPrefix) {
    return '<select class="explorer-select" id="' + idPrefix + '-var">' +
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
        '<optgroup label="Original Swath" id="' + idPrefix + '-var-original">' +
            '<option value="swath_tangential_wind">Tangential Wind</option>' +
            '<option value="swath_radial_wind">Radial Wind</option>' +
            '<option value="swath_reflectivity">Reflectivity</option>' +
            '<option value="swath_wind_speed">Wind Speed</option>' +
            '<option value="swath_earth_relative_wind_speed">Earth-Rel. Wind Speed</option>' +
        '</optgroup>' +
    '</select>';
}

// ── Original-domain variable definitions per data type ───────
var _originalVarDefs = {
    swath: [
        { value: 'swath_tangential_wind', label: 'Tangential Wind' },
        { value: 'swath_radial_wind', label: 'Radial Wind' },
        { value: 'swath_reflectivity', label: 'Reflectivity' },
        { value: 'swath_wind_speed', label: 'Wind Speed' },
        { value: 'swath_earth_relative_wind_speed', label: 'Earth-Rel. Wind Speed' }
    ],
    merge: [
        { value: 'merged_tangential_wind', label: 'Tangential Wind' },
        { value: 'merged_radial_wind', label: 'Radial Wind' },
        { value: 'merged_reflectivity', label: 'Reflectivity' },
        { value: 'merged_wind_speed', label: 'Wind Speed' },
        { value: 'merged_upward_air_velocity', label: 'Vertical Velocity' },
        { value: 'merged_relative_vorticity', label: 'Relative Vorticity' },
        { value: 'merged_divergence', label: 'Divergence' }
    ]
};

function _updateOriginalVarGroup(idPrefix, dataType) {
    var og = document.getElementById(idPrefix + '-var-original');
    if (!og) return;
    var defs = _originalVarDefs[dataType] || _originalVarDefs.swath;
    og.label = dataType === 'merge' ? 'Original Merged' : 'Original Swath';
    og.innerHTML = '';
    defs.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d.value; opt.textContent = d.label;
        og.appendChild(opt);
    });
    // If currently selected value was in the old original group, reset to first recentered
    var sel = document.getElementById(idPrefix + '-var');
    if (sel && sel.selectedOptions.length && sel.selectedOptions[0].parentElement === og) {
        sel.value = 'recentered_tangential_wind';
    }
}

function _updateCompOverlayOriginalGroup(dataType) {
    var og = document.getElementById('comp-overlay-original');
    if (!og) return;
    var defs = _originalVarDefs[dataType] || _originalVarDefs.swath;
    og.label = dataType === 'merge' ? 'Original Merged' : 'Original Swath';
    og.innerHTML = '';
    defs.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d.value; opt.textContent = d.label;
        og.appendChild(opt);
    });
    var sel = document.getElementById('comp-overlay');
    if (sel && sel.selectedOptions.length && sel.selectedOptions[0].parentElement === og) {
        sel.value = '';  // reset to None
    }
}

function _buildRangeRow(label, idBase, min, max, step, defaultMin, defaultMax, units) {
    return '<div class="comp-filter-row"><label>' + label + '</label>' +
        '<div class="comp-range-inputs">' +
            '<input type="number" id="' + idBase + '-min" value="' + defaultMin + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
            '<span class="comp-range-sep">to</span>' +
            '<input type="number" id="' + idBase + '-max" value="' + defaultMax + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
            '<span class="comp-range-unit">' + units + '</span>' +
        '</div></div>';
}

function initCompositePanel() {
    if (_compositePanel) return;
    var overlay = document.createElement('div');
    overlay.id = 'composite-panel';
    overlay.className = 'composite-overlay';
    overlay.innerHTML =
        '<div class="composite-box">' +
            '<div class="composite-header">' +
                '<div class="composite-header-left">' +
                    '<span class="composite-logo">\uD83D\uDCCA</span> ' +
                    '<span class="composite-title">Composite Analysis</span>' +
                    '<span class="composite-subtitle">Multi-case averaged fields</span>' +
                '</div>' +
                '<button class="composite-close" onclick="toggleCompositePanel()">\u2715</button>' +
            '</div>' +
            '<div class="composite-body">' +
                // ── Left: Controls ──
                '<div class="composite-controls">' +
                    '<div class="comp-section-title">\uD83C\uDFAF Variable & Grid</div>' +
                    '<div class="comp-filter-row"><label>Variable</label>' + _varOptionsHTML('comp') + '</div>' +
                    '<div class="comp-filter-row"><label>Data Type</label>' +
                        '<select class="explorer-select" id="comp-dtype"><option value="swath">Swath</option><option value="merge">Merge</option></select>' +
                    '</div>' +
                    '<div class="comp-filter-row"><label>Coverage</label>' +
                        '<div style="display:flex;align-items:center;gap:6px;">' +
                            '<input type="range" id="comp-coverage" min="0" max="100" step="5" value="50" class="az-cov-slider" oninput="document.getElementById(\'comp-cov-val\').textContent=this.value+\'%\'">' +
                            '<span id="comp-cov-val" style="font-size:11px;font-weight:600;color:var(--cyan);min-width:32px;font-family:\'JetBrains Mono\',monospace;">50%</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="comp-filter-row"><label>Contour Overlay</label>' +
                        '<select class="explorer-select" id="comp-overlay" style="font-size:11px;">' +
                            '<option value="">None</option>' +
                            '<optgroup label="WCM Recentered (2 km)">' +
                                '<option value="recentered_tangential_wind">Tangential Wind</option>' +
                                '<option value="recentered_radial_wind">Radial Wind</option>' +
                                '<option value="recentered_upward_air_velocity">Vertical Velocity</option>' +
                                '<option value="recentered_reflectivity">Reflectivity</option>' +
                                '<option value="recentered_wind_speed">Wind Speed</option>' +
                                '<option value="recentered_relative_vorticity">Relative Vorticity</option>' +
                                '<option value="recentered_divergence">Divergence</option>' +
                            '</optgroup>' +
                            '<optgroup label="Tilt-Relative">' +
                                '<option value="total_recentered_tangential_wind">Tangential Wind</option>' +
                                '<option value="total_recentered_radial_wind">Radial Wind</option>' +
                                '<option value="total_recentered_upward_air_velocity">Vertical Velocity</option>' +
                                '<option value="total_recentered_reflectivity">Reflectivity</option>' +
                                '<option value="total_recentered_wind_speed">Wind Speed</option>' +
                            '</optgroup>' +
                            '<optgroup label="Original Swath" id="comp-overlay-original">' +
                                '<option value="swath_tangential_wind">Tangential Wind</option>' +
                                '<option value="swath_radial_wind">Radial Wind</option>' +
                                '<option value="swath_reflectivity">Reflectivity</option>' +
                                '<option value="swath_wind_speed">Wind Speed</option>' +
                            '</optgroup>' +
                        '</select>' +
                        '<div style="display:flex;align-items:center;gap:5px;margin-top:2px;">' +
                            '<label style="font-size:9px;white-space:nowrap;margin:0;">Int:</label>' +
                            '<input type="number" id="comp-contour-int" value="" placeholder="auto" style="width:55px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);">' +
                        '</div>' +
                    '</div>' +
                    '<div class="comp-section-title" style="margin-top:14px;">\uD83C\uDFA8 Display</div>' +
                    '<div class="comp-filter-row"><label>Colormap</label>' +
                        '<select class="explorer-select" id="comp-cmap" style="font-size:11px;" onchange="applyCompCmap()">' +
                            '<option value="">Default (from variable)</option>' +
                            '<optgroup label="Sequential"><option value="Viridis">Viridis</option><option value="Inferno">Inferno</option><option value="Magma">Magma</option><option value="Plasma">Plasma</option><option value="Cividis">Cividis</option><option value="Hot">Hot</option><option value="YlOrRd">YlOrRd</option><option value="YlGnBu">YlGnBu</option><option value="Blues">Blues</option><option value="Reds">Reds</option><option value="Greys">Greys</option></optgroup>' +
                            '<optgroup label="Diverging"><option value="RdBu">RdBu (red-blue)</option><option value=\'[[0,"rgb(5,10,172)"],[0.5,"rgb(255,255,255)"],[1,"rgb(178,10,28)"]]\'>BuWtRd (blue-white-red)</option><option value="Picnic">Picnic</option><option value="Portland">Portland</option></optgroup>' +
                            '<optgroup label="Other"><option value="Jet">Jet</option><option value="Rainbow">Rainbow</option><option value="Electric">Electric</option><option value="Earth">Earth</option><option value="Blackbody">Blackbody</option></optgroup>' +
                        '</select>' +
                    '</div>' +
                    '<div class="comp-filter-row"><label>Color Range</label>' +
                        '<div style="display:flex;align-items:center;gap:4px;">' +
                            '<input type="number" id="comp-vmin" placeholder="min" step="any" style="width:60px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyCompColorRange()">' +
                            '<span style="font-size:10px;color:var(--slate);">to</span>' +
                            '<input type="number" id="comp-vmax" placeholder="max" step="any" style="width:60px;padding:2px 4px;font-size:10px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);color:var(--text);" onchange="applyCompColorRange()">' +
                            '<button onclick="resetCompColorRange()" title="Reset to default" style="padding:2px 5px;font-size:9px;border:1px solid var(--border-light);border-radius:4px;background:var(--navy);cursor:pointer;color:var(--slate);">\u21BA</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="comp-section-title" style="margin-top:14px;">\uD83D\uDD0D Filter Criteria</div>' +
                    _buildRangeRow('Intensity', 'comp-int', 0, 200, 5, 0, 200, 'kt') +
                    _buildRangeRow('24-h \u0394V<sub>max</sub>', 'comp-dv', -100, 85, 5, -100, 85, 'kt') +
                    _buildRangeRow('Tilt', 'comp-tilt', 0, 200, 5, 0, 200, 'km') +
                    _buildRangeRow('Year', 'comp-year', 1997, 2024, 1, 1997, 2024, '') +
                    _buildRangeRow('Shear Mag', 'comp-shrmag', 0, 100, 2, 0, 100, 'kt') +
                    _buildRangeRow('Shear Dir', 'comp-shrdir', 0, 360, 5, 0, 360, '\u00b0') +
                    '<div class="comp-case-count" id="comp-count-display">' +
                        '<span class="comp-count-label">Matching cases:</span> ' +
                        '<span class="comp-count-num" id="comp-count-num">\u2014</span>' +
                    '</div>' +
                    '<div class="comp-actions">' +
                        '<button class="comp-btn comp-btn-primary" id="comp-btn-az" onclick="generateCompositeAzMean()">\u27F3 Azimuthal Mean</button>' +
                        '<button class="comp-btn comp-btn-accent" id="comp-btn-sq" onclick="generateCompositeQuadMean()">\u25D1 Shear Quadrants</button>' +
                    '</div>' +
                '</div>' +
                // ── Right: Results ──
                '<div class="composite-results">' +
                    '<div class="comp-result-placeholder" id="comp-result-placeholder">' +
                        '<div class="comp-result-icon">\uD83C\uDF00</div>' +
                        '<div class="comp-result-msg">Set filter criteria and click a generate button to compute a composite.</div>' +
                    '</div>' +
                    '<div id="comp-status" style="display:none;"></div>' +
                    '<div id="comp-result-az" style="display:none;"></div>' +
                    '<div id="comp-result-sq" style="display:none;"></div>' +
                '</div>' +
            '</div>' +
        '</div>';
    document.body.appendChild(overlay);
    _compositePanel = overlay;

    // Wire up live case count on filter changes
    var filterInputs = overlay.querySelectorAll('input[type="number"], select, input[type="range"]');
    filterInputs.forEach(function(inp) {
        inp.addEventListener('change', _debouncedCompositeCount);
        inp.addEventListener('input', _debouncedCompositeCount);
    });

    // Wire up data type change to swap original-domain variable options
    var dtypeSelect = document.getElementById('comp-dtype');
    if (dtypeSelect) {
        dtypeSelect.addEventListener('change', function() {
            var varType = this.value === 'merge' ? 'merge' : 'swath';
            _updateOriginalVarGroup('comp', varType);
            _updateCompOverlayOriginalGroup(varType);
            _debouncedCompositeCount();
        });
    }

    _injectCompositeStyles();
}

function _injectCompositeStyles() {
    if (document.getElementById('composite-styles')) return;
    var style = document.createElement('style');
    style.id = 'composite-styles';
    style.textContent =
        '.composite-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; z-index:3000; background:rgba(0,0,0,0.85); backdrop-filter:blur(8px); overflow-y:auto; }' +
        '.composite-overlay.active { display:flex; align-items:flex-start; justify-content:center; padding:20px; }' +
        '.composite-box { width:100%; max-width:1400px; background:var(--navy, #0a1628); border:1px solid rgba(255,255,255,0.08); border-radius:12px; overflow:hidden; box-shadow:0 25px 50px rgba(0,0,0,0.5); }' +
        '.composite-header { display:flex; justify-content:space-between; align-items:center; padding:16px 24px; border-bottom:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.02); }' +
        '.composite-header-left { display:flex; align-items:center; gap:10px; }' +
        '.composite-logo { font-size:20px; }' +
        '.composite-title { font-size:18px; font-weight:700; color:#e5e7eb; font-family:"JetBrains Mono",monospace; }' +
        '.composite-subtitle { font-size:12px; color:#6b7280; margin-left:4px; }' +
        '.composite-close { background:none; border:1px solid rgba(255,255,255,0.1); color:#9ca3af; font-size:18px; width:36px; height:36px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s; }' +
        '.composite-close:hover { background:rgba(255,255,255,0.05); color:#e5e7eb; }' +
        '.composite-body { display:flex; min-height:600px; }' +
        '.composite-controls { width:320px; min-width:320px; padding:20px; border-right:1px solid rgba(255,255,255,0.06); overflow-y:auto; max-height:calc(100vh - 120px); }' +
        '.composite-results { flex:1; padding:20px; overflow-y:auto; max-height:calc(100vh - 120px); display:flex; flex-direction:column; }' +
        '.comp-section-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:var(--cyan, #22d3ee); margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid rgba(34,211,238,0.15); }' +
        '.comp-filter-row { margin-bottom:10px; }' +
        '.comp-filter-row label { display:block; font-size:11px; font-weight:600; color:#9ca3af; margin-bottom:3px; font-family:"JetBrains Mono",monospace; }' +
        '.comp-range-inputs { display:flex; align-items:center; gap:5px; }' +
        '.comp-range-inputs input[type="number"] { width:65px; padding:4px 6px; font-size:11px; border:1px solid rgba(255,255,255,0.1); border-radius:4px; background:rgba(255,255,255,0.03); color:#e5e7eb; font-family:"JetBrains Mono",monospace; }' +
        '.comp-range-sep { font-size:10px; color:#6b7280; }' +
        '.comp-range-unit { font-size:10px; color:#6b7280; min-width:18px; }' +
        '.comp-case-count { margin:16px 0; padding:12px; background:rgba(34,211,238,0.05); border:1px solid rgba(34,211,238,0.15); border-radius:8px; text-align:center; }' +
        '.comp-count-label { font-size:11px; color:#9ca3af; }' +
        '.comp-count-num { font-size:22px; font-weight:700; color:var(--cyan, #22d3ee); font-family:"JetBrains Mono",monospace; }' +
        '.comp-actions { display:flex; flex-direction:column; gap:8px; margin-top:8px; }' +
        '.comp-btn { padding:10px 16px; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:"JetBrains Mono",monospace; transition:all 0.15s; }' +
        '.comp-btn:disabled { opacity:0.4; cursor:not-allowed; }' +
        '.comp-btn-primary { background:var(--cyan, #22d3ee); color:#0a1628; }' +
        '.comp-btn-primary:hover:not(:disabled) { background:#67e8f9; }' +
        '.comp-btn-accent { background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); }' +
        '.comp-btn-accent:hover:not(:disabled) { background:rgba(245,158,11,0.25); }' +
        '.comp-result-placeholder { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#4b5563; }' +
        '.comp-result-icon { font-size:48px; margin-bottom:12px; opacity:0.4; }' +
        '.comp-result-msg { font-size:13px; text-align:center; max-width:320px; line-height:1.6; }' +
        '.comp-status { padding:12px 16px; border-radius:8px; font-size:12px; font-family:"JetBrains Mono",monospace; margin-bottom:12px; }' +
        '.comp-status.loading { background:rgba(34,211,238,0.08); color:var(--cyan, #22d3ee); border:1px solid rgba(34,211,238,0.2); }' +
        '.comp-status.success { background:rgba(16,185,129,0.08); color:#10b981; border:1px solid rgba(16,185,129,0.2); }' +
        '.comp-status.error { background:rgba(239,68,68,0.08); color:#ef4444; border:1px solid rgba(239,68,68,0.2); }' +
        '@media (max-width:900px) { .composite-body { flex-direction:column; } .composite-controls { width:100%; min-width:auto; border-right:none; border-bottom:1px solid rgba(255,255,255,0.06); max-height:none; } .composite-results { min-height:500px; } }';
    document.head.appendChild(style);
}

function toggleCompositePanel() {
    initCompositePanel();
    var panel = document.getElementById('composite-panel');
    panel.classList.toggle('active');
    if (panel.classList.contains('active')) {
        updateCompositeCount();
    }
}

function _getCompositeFilters() {
    return {
        min_intensity:   parseFloat(document.getElementById('comp-int-min').value) || 0,
        max_intensity:   parseFloat(document.getElementById('comp-int-max').value) || 200,
        min_vmax_change: parseFloat(document.getElementById('comp-dv-min').value) || -100,
        max_vmax_change: parseFloat(document.getElementById('comp-dv-max').value) || 85,
        min_tilt:        parseFloat(document.getElementById('comp-tilt-min').value) || 0,
        max_tilt:        parseFloat(document.getElementById('comp-tilt-max').value) || 200,
        min_year:        parseInt(document.getElementById('comp-year-min').value) || 1997,
        max_year:        parseInt(document.getElementById('comp-year-max').value) || 2024,
        min_shear_mag:   parseFloat(document.getElementById('comp-shrmag-min').value) || 0,
        max_shear_mag:   parseFloat(document.getElementById('comp-shrmag-max').value) || 100,
        min_shear_dir:   parseFloat(document.getElementById('comp-shrdir-min').value) || 0,
        max_shear_dir:   parseFloat(document.getElementById('comp-shrdir-max').value) || 360,
    };
}

function _compositeQueryString(filters) {
    var parts = [];
    for (var k in filters) { parts.push(k + '=' + encodeURIComponent(filters[k])); }
    return parts.join('&');
}

function _debouncedCompositeCount() {
    clearTimeout(_compositeCountTimeout);
    _compositeCountTimeout = setTimeout(updateCompositeCount, 400);
}

function updateCompositeCount() {
    var filters = _getCompositeFilters();
    var dataType = document.getElementById('comp-dtype').value || 'swath';
    var el = document.getElementById('comp-count-num');
    el.textContent = '\u2026';
    fetch(API_BASE + '/composite/count?' + _compositeQueryString(filters) + '&data_type=' + dataType)
        .then(function(r) { return r.json(); })
        .then(function(json) { el.textContent = json.count; })
        .catch(function() { el.textContent = '?'; });
}

function _compositeFilterSummary(filters, nCases) {
    var parts = [];
    if (filters.min_intensity > 0 || filters.max_intensity < 200)
        parts.push(filters.min_intensity + '\u2013' + filters.max_intensity + ' kt');
    if (filters.min_vmax_change > -100 || filters.max_vmax_change < 85)
        parts.push('\u0394V ' + filters.min_vmax_change + ' to ' + filters.max_vmax_change + ' kt');
    if (filters.min_tilt > 0 || filters.max_tilt < 200)
        parts.push('Tilt ' + filters.min_tilt + '\u2013' + filters.max_tilt + ' km');
    if (filters.min_year > 1997 || filters.max_year < 2024)
        parts.push(filters.min_year + '\u2013' + filters.max_year);
    if (filters.min_shear_mag > 0 || filters.max_shear_mag < 100)
        parts.push('Shr ' + filters.min_shear_mag + '\u2013' + filters.max_shear_mag + ' kt');
    if (filters.min_shear_dir > 0 || filters.max_shear_dir < 360)
        parts.push('Dir ' + filters.min_shear_dir + '\u2013' + filters.max_shear_dir + '\u00b0');
    var summary = parts.length > 0 ? parts.join(' | ') : 'All cases';
    return 'Composite (N=' + nCases + ') | ' + summary;
}

function _computeCompositeMeanVmax(filters) {
    var dataType = document.getElementById('comp-dtype') ? document.getElementById('comp-dtype').value : 'swath';
    var source = (dataType === 'merge' && mergeData) ? mergeData : allData;
    if (!source || !source.cases) return null;
    var sum = 0, count = 0;
    source.cases.forEach(function(c) {
        if (c.vmax_kt === null || c.vmax_kt === undefined) return;
        var v = c.vmax_kt;
        if (v < filters.min_intensity || v > filters.max_intensity) return;
        if (filters.min_vmax_change > -100 || filters.max_vmax_change < 85) {
            if (c['24-h_vmax_change_kt'] === null || c['24-h_vmax_change_kt'] === undefined) return;
            var dv = c['24-h_vmax_change_kt'];
            if (dv < filters.min_vmax_change || dv > filters.max_vmax_change) return;
        }
        if (filters.min_tilt > 0 || filters.max_tilt < 200) {
            if (c.tilt_magnitude_km === null || c.tilt_magnitude_km === undefined) return;
            if (c.tilt_magnitude_km < filters.min_tilt || c.tilt_magnitude_km > filters.max_tilt) return;
        }
        if (c.year < filters.min_year || c.year > filters.max_year) return;
        if (filters.min_shear_mag > 0 || filters.max_shear_mag < 100) {
            var sm = c.shear_magnitude_kt !== undefined ? c.shear_magnitude_kt : null;
            if (sm === null) return;
            if (sm < filters.min_shear_mag || sm > filters.max_shear_mag) return;
        }
        if (filters.min_shear_dir > 0 || filters.max_shear_dir < 360) {
            var sd = c.sddc !== undefined ? c.sddc : null;
            if (sd === null) return;
            if (sd < filters.min_shear_dir || sd > filters.max_shear_dir) return;
        }
        sum += v; count++;
    });
    return count > 0 ? Math.round(sum / count) : null;
}

function _showCompStatus(cls, msg) {
    var el = document.getElementById('comp-status');
    el.className = 'comp-status ' + cls;
    el.textContent = msg;
    el.style.display = 'block';
}

// ── Composite overlay contour helpers ─────────────────────────
function _compContourInterval(ovData) {
    var intInput = document.getElementById('comp-contour-int');
    var interval = intInput ? parseFloat(intInput.value) : NaN;
    if (isNaN(interval) || interval <= 0) {
        var flat = ovData.flat().filter(function(v) { return v !== null && !isNaN(v); });
        if (flat.length === 0) return 1;
        var mn = Infinity, mx = -Infinity;
        for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
        interval = parseFloat(((mx - mn) / 10).toPrecision(1));
        if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
    }
    return interval;
}

function buildCompAzOverlayContours(json, radius, height_km) {
    if (!json.overlay) return [];
    var ov = json.overlay; var ovData = ov.azimuthal_mean; if (!ovData) return [];
    try {
        var interval = _compContourInterval(ovData);
        var baseContour = { z: ovData, x: radius, y: height_km, type: 'contour', showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(255,255,255,0.8)' } } };
        var traces = [];
        if (ov.vmax > interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (+)', showlegend: false }));
        if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (\u2212)', showlegend: false }));
        return traces;
    } catch (e) { console.warn('Composite az overlay error:', e); return []; }
}

function buildCompQuadOverlayContours(json, radius, height_km, panelOrder) {
    if (!json.overlay || !json.overlay.quadrant_means) return [];
    var ov = json.overlay; var traces = [];
    try {
        // Use first available quadrant data for interval calc
        var firstQ = null;
        for (var k in ov.quadrant_means) { if (ov.quadrant_means[k] && ov.quadrant_means[k].data) { firstQ = ov.quadrant_means[k].data; break; } }
        if (!firstQ) return [];
        var interval = _compContourInterval(firstQ);
        panelOrder.forEach(function(p, i) {
            var ovQ = ov.quadrant_means[p.key]; if (!ovQ || !ovQ.data) return;
            var axSuffix = i === 0 ? '' : String(i + 1);
            var baseContour = { z: ovQ.data, x: radius, y: height_km, type: 'contour', xaxis: 'x' + axSuffix, yaxis: 'y' + axSuffix, showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 8, color: 'rgba(255,255,255,0.7)' } } };
            if (ov.vmax > interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.6)', width: 1, dash: 'solid' }, showlegend: false }));
            if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.6)', width: 1, dash: 'dash' }, showlegend: false }));
        });
        return traces;
    } catch (e) { console.warn('Composite quad overlay error:', e); return []; }
}

function renderCompositeAzMeanInto(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;
    var azData = json.azimuthal_mean, radius = json.radius_rrmw, height_km = json.height_km, varInfo = json.variable;
    var isNorm = json.normalized;
    var rLabel = isNorm ? 'R / RMW' : 'Radius (km)';
    var fontSize = { title:14, axis:12, tick:10, cbar:12, cbarTick:10, hover:13 };
    // Store defaults and update placeholders
    _compDefaultColorscale = varInfo.colorscale; _compDefaultVmin = varInfo.vmin; _compDefaultVmax = varInfo.vmax;
    var vminInp = document.getElementById('comp-vmin'), vmaxInp = document.getElementById('comp-vmax');
    if (vminInp) vminInp.placeholder = varInfo.vmin; if (vmaxInp) vmaxInp.placeholder = varInfo.vmax;
    // Apply user overrides
    var activeColorscale = _getCompColorscale(varInfo.colorscale);
    var activeVmin = _getCompVmin(varInfo.vmin);
    var activeVmax = _getCompVmax(varInfo.vmax);
    var heatmap = {
        z: azData, x: radius, y: height_km, type: 'heatmap',
        colorscale: activeColorscale, zmin: activeVmin, zmax: activeVmax,
        colorbar: { title: { text: varInfo.units, font: { color:'#ccc', size:fontSize.cbar } }, tickfont: { color:'#ccc', size:fontSize.cbarTick }, thickness:14, len:0.85 },
        hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>' + rLabel + ': %{x:.2f}<br>Height: %{y:.1f} km<extra></extra>',
        hoverongaps: false
    };
    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var rmwNote = isNorm ? ' | N(RMW)=' + (json.n_with_rmw || json.n_cases) : '';
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    var title = _compositeFilterSummary(filters, json.n_cases) + vmaxNote + rmwNote +
               '<br>Azimuthal Mean: ' + varInfo.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)' + overlayLabel;
    var plotBg = '#0a1628';
    var shapes = [];
    // RMW reference line at R/RMW = 1
    if (isNorm) shapes.push({ type:'line', xref:'x', yref:'paper', x0:1, x1:1, y0:0, y1:1, line:{ color:'white', width:1.5, dash:'dash' } });
    var layout = {
        title: { text: title, font: { color:'#e5e7eb', size:fontSize.title }, y:0.97, x:0.5, xanchor:'center' },
        paper_bgcolor: plotBg, plot_bgcolor: plotBg,
        xaxis: { title: { text:rLabel, font:{color:'#aaa',size:fontSize.axis} }, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
        yaxis: { title: { text:'Height (km)', font:{color:'#aaa',size:fontSize.axis} }, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false },
        margin: { l:55, r:24, t: json.overlay ? 110 : 96, b:46 }, shapes: shapes,
        hoverlabel: { bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
        showlegend: false
    };
    var maxInfo = findDataMax(azData, radius, height_km);
    if (maxInfo) {
        var maxAnnot = buildMaxAnnotation(maxInfo, varInfo.units, isNorm ? 'R/RMW' : 'R', 'Z', 10);
        if (maxAnnot) layout.annotations = (layout.annotations || []).concat([maxAnnot]);
    }
    var compAzOverlay = buildCompAzOverlayContours(json, radius, height_km);
    el.style.display = 'block';
    el.innerHTML = '<div id="comp-az-chart" style="width:100%;height:540px;border-radius:8px;overflow:hidden;"></div>';
    Plotly.newPlot('comp-az-chart', [heatmap].concat(compAzOverlay), layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
}

function renderCompositeQuadMeanInto(targetId, json, filters) {
    var el = document.getElementById(targetId); if (!el) return;
    var quads = json.quadrant_means;
    var radius = json.radius_rrmw, height_km = json.height_km, varInfo = json.variable;
    var isNorm = json.normalized;
    var rLabel = isNorm ? 'R / RMW' : 'Radius (km)';
    var fontSize = { title:14, axis:11, tick:10, cbar:11, cbarTick:10, hover:12, panel:12 };
    // Store defaults and update placeholders
    _compDefaultColorscale = varInfo.colorscale; _compDefaultVmin = varInfo.vmin; _compDefaultVmax = varInfo.vmax;
    var vminInp = document.getElementById('comp-vmin'), vmaxInp = document.getElementById('comp-vmax');
    if (vminInp) vminInp.placeholder = varInfo.vmin; if (vmaxInp) vmaxInp.placeholder = varInfo.vmax;
    // Apply user overrides
    var activeColorscale = _getCompColorscale(varInfo.colorscale);
    var zmin = _getCompVmin(varInfo.vmin), zmax = _getCompVmax(varInfo.vmax);

    var panelOrder = [
        { key:'USL', label:'Upshear Left', row:0, col:0 },
        { key:'DSL', label:'Downshear Left', row:0, col:1 },
        { key:'USR', label:'Upshear Right', row:1, col:0 },
        { key:'DSR', label:'Downshear Right', row:1, col:1 }
    ];

    var traces = [], annotations = [], shapes = [];
    var gap=0.08, cbarW=0.04, leftM=0.06, rightM=0.02+cbarW+0.02, topM=0.16, botM=0.06;
    var pw = (1-leftM-rightM-gap)/2, ph = (1-topM-botM-gap)/2;
    var quadColors = { DSL:'#f59e0b', DSR:'#f59e0b', USL:'#60a5fa', USR:'#60a5fa' };

    panelOrder.forEach(function(p, i) {
        var qData = quads[p.key];
        if (!qData || !qData.data) return;
        var x0 = leftM + p.col * (pw + gap);
        var x1 = x0 + pw;
        var yTop = 1 - topM - p.row * ph - p.row * gap;
        var yBottom = 1 - topM - (p.row+1) * ph - p.row * gap;
        var axSuffix = i === 0 ? '' : String(i+1);
        var showCbar = (i === 1);
        traces.push({
            z:qData.data, x:radius, y:height_km, type:'heatmap',
            colorscale:activeColorscale, zmin:zmin, zmax:zmax,
            xaxis:'x'+axSuffix, yaxis:'y'+axSuffix,
            showscale:showCbar,
            colorbar: showCbar ? { title:{text:varInfo.units,font:{color:'#ccc',size:fontSize.cbar}}, tickfont:{color:'#ccc',size:fontSize.cbarTick}, thickness:14, len:0.85, x:1.02, y:0.5 } : undefined,
            hovertemplate:'<b>'+p.label+'</b><br>'+varInfo.display_name+': %{z:.2f} '+varInfo.units+'<br>'+rLabel+': %{x:.2f}<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps:false
        });
        annotations.push({
            text:'<b>'+p.label+'</b>', xref:'paper', yref:'paper',
            x:(x0+x1)/2, y:yTop+0.005, xanchor:'center', yanchor:'bottom', showarrow:false,
            font:{ color:quadColors[p.key]||'#ccc', size:fontSize.panel, family:'JetBrains Mono, monospace' },
            bgcolor:'rgba(10,22,40,0.7)', borderpad:2
        });
        // RMW reference line at R/RMW = 1
        if (isNorm) {
            shapes.push({ type:'line', xref:'x'+axSuffix, yref:'y'+axSuffix,
                x0:1, x1:1, y0:height_km[0], y1:height_km[height_km.length-1],
                line:{ color:'white', width:1, dash:'dash' } });
        }
    });

    // Shear arrow inset at center
    var shearInset = buildShearInset(90, true);
    annotations = annotations.concat(shearInset.annotations || []);

    var covPct = Math.round((json.coverage_min || 0.5) * 100);
    var rmwNote = isNorm ? ' | N(RMW+Shr)=' + (json.n_with_shear_and_rmw || json.n_cases) : '';
    var dtypeLabel = (document.getElementById('comp-dtype') && document.getElementById('comp-dtype').value === 'merge') ? ' (Merge)' : '';
    var meanVmax = _computeCompositeMeanVmax(filters);
    var vmaxNote = meanVmax !== null ? ' | Mean V<sub>max</sub>=' + meanVmax + ' kt' : '';
    var title = _compositeFilterSummary(filters, json.n_cases) + vmaxNote + rmwNote +
               '<br>Shear-Relative Quadrant Mean: ' + varInfo.display_name + dtypeLabel + ' (\u2265' + covPct + '% cov.)';
    var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    title += overlayLabel;

    var plotBg = '#0a1628';
    var layoutAxes = {};
    panelOrder.forEach(function(p, i) {
        var x0 = leftM + p.col * (pw + gap);
        var x1 = x0 + pw;
        var yBottom = 1 - topM - (p.row+1) * ph - p.row * gap;
        var yTop = 1 - topM - p.row * ph - p.row * gap;
        var axSuffix = i === 0 ? '' : String(i+1);
        var showYLabel = (p.col === 0), showXLabel = (p.row === 1);
        layoutAxes['xaxis' + axSuffix] = { domain:[x0,x1], title:showXLabel?{text:rLabel,font:{color:'#aaa',size:fontSize.axis}}:undefined, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false, anchor:'y'+axSuffix };
        layoutAxes['yaxis' + axSuffix] = { domain:[yBottom,yTop], title:showYLabel?{text:'Height (km)',font:{color:'#aaa',size:fontSize.axis}}:undefined, tickfont:{color:'#aaa',size:fontSize.tick}, gridcolor:'rgba(255,255,255,0.04)', zeroline:false, anchor:'x'+axSuffix };
    });

    var compQuadOverlay = buildCompQuadOverlayContours(json, radius, height_km, panelOrder);

    var layout = Object.assign({
        title:{ text:title, font:{color:'#e5e7eb',size:fontSize.title}, y:0.99, x:0.5, xanchor:'center' },
        paper_bgcolor:plotBg, plot_bgcolor:plotBg,
        margin:{ l:50, r:60, t: json.overlay ? 110 : 96, b:50 },
        annotations:annotations, shapes:shapes.concat(shearInset.shapes || []),
        hoverlabel:{ bgcolor:'#1f2937', font:{color:'#e5e7eb',size:fontSize.hover} },
        showlegend:false
    }, layoutAxes);

    el.style.display = 'block';
    el.innerHTML = '<div id="comp-sq-chart" style="width:100%;height:700px;border-radius:8px;overflow:hidden;"></div>';
    Plotly.newPlot('comp-sq-chart', traces.concat(compQuadOverlay), layout, { responsive:true, displayModeBar:true, displaylogo:false, modeBarButtonsToRemove:['lasso2d','select2d','toggleSpikelines'] });
}

function generateCompositeAzMean() {
    var filters = _getCompositeFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;
    var btnAz = document.getElementById('comp-btn-az'), btnSq = document.getElementById('comp-btn-sq');
    btnAz.disabled = true; btnSq.disabled = true;
    btnAz.textContent = '\u23F3 Computing\u2026';
    document.getElementById('comp-result-placeholder').style.display = 'none';
    document.getElementById('comp-result-sq').style.display = 'none';
    _showCompStatus('loading', 'Computing composite azimuthal mean \u2014 this may take 30\u201390 seconds for many cases\u2026');

    var overlay = (document.getElementById('comp-overlay') || {}).value || '';
    var qs = _compositeQueryString(filters) + '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType + '&coverage_min=' + coverage;
    if (overlay) qs += '&overlay=' + encodeURIComponent(overlay);
    fetch(API_BASE + '/composite/azimuthal_mean?' + qs)
        .then(function(r) { if (!r.ok) return r.json().then(function(e){throw new Error(e.detail||'API error');}); return r.json(); })
        .then(function(json) {
            _showCompStatus('success', '\u2713 Composite computed: ' + json.n_cases + ' cases processed');
            renderCompositeAzMeanInto('comp-result-az', json, filters);
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 ' + err.message); })
        .finally(function() {
            btnAz.disabled = false; btnSq.disabled = false;
            btnAz.textContent = '\u27F3 Azimuthal Mean';
        });
}

function generateCompositeQuadMean() {
    var filters = _getCompositeFilters();
    var variable = document.getElementById('comp-var').value;
    var dataType = document.getElementById('comp-dtype').value;
    var coverage = parseInt(document.getElementById('comp-coverage').value) / 100;
    var btnAz = document.getElementById('comp-btn-az'), btnSq = document.getElementById('comp-btn-sq');
    btnAz.disabled = true; btnSq.disabled = true;
    btnSq.textContent = '\u23F3 Computing\u2026';
    document.getElementById('comp-result-placeholder').style.display = 'none';
    document.getElementById('comp-result-az').style.display = 'none';
    _showCompStatus('loading', 'Computing composite shear quadrants \u2014 this may take 30\u201390 seconds for many cases\u2026');

    var overlay = (document.getElementById('comp-overlay') || {}).value || '';
    var qs = _compositeQueryString(filters) + '&variable=' + encodeURIComponent(variable) + '&data_type=' + dataType + '&coverage_min=' + coverage;
    if (overlay) qs += '&overlay=' + encodeURIComponent(overlay);
    fetch(API_BASE + '/composite/quadrant_mean?' + qs)
        .then(function(r) { if (!r.ok) return r.json().then(function(e){throw new Error(e.detail||'API error');}); return r.json(); })
        .then(function(json) {
            _showCompStatus('success', '\u2713 Composite computed: ' + json.n_cases + ' cases processed (' + json.n_with_shear + ' with shear data)');
            renderCompositeQuadMeanInto('comp-result-sq', json, filters);
        })
        .catch(function(err) { _showCompStatus('error', '\u2717 ' + err.message); })
        .finally(function() {
            btnAz.disabled = false; btnSq.disabled = false;
            btnSq.textContent = '\u25D1 Shear Quadrants';
        });
}

// Close composite panel on Escape
(function() {
    var orig = document.onkeydown;
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var cp = document.getElementById('composite-panel');
            if (cp && cp.classList.contains('active')) { toggleCompositePanel(); e.stopPropagation(); }
        }
    });
})();
