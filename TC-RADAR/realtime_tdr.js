/**
 * realtime_tdr.js — Real-Time TDR Visualization Tab
 * ===================================================
 * Standalone module for browsing and visualizing real-time Tail Doppler
 * Radar analyses from seb.omao.noaa.gov/pub/flight/radar/.
 *
 * This file is completely independent of tc_radar_app.js — it manages
 * its own state, DOM elements, and API calls within the #realtime-section.
 *
 * Depends on: Plotly (loaded globally by index.html)
 */

(function () {
    'use strict';

    // ── Configuration ────────────────────────────────────────────
    var API_BASE = 'https://tc-radar-api.onrender.com';
    var RT_PREFIX = '/realtime';

    // ── State ────────────────────────────────────────────────────
    var _rtVisible = false;
    var _currentFileUrl = null;
    var _rtDataCache = {};
    var _rtLast3DJson = null;
    var _rtLastPlotlyData = null;
    var _rtCsMode = false;
    var _rtCsPointA = null;
    var _rtCsMouseHandler = null;
    var _rtAnimPlaying = false;
    var _rtAnimTimer = null;
    var _rtDefaultColorscale = null;
    var _rtDefaultVmin = null;
    var _rtDefaultVmax = null;

    // IR satellite imagery (GOES) state
    var _rtIRData = null;           // metadata from /realtime/ir
    var _rtIRFrameURLs = [];        // array of data-URL strings (or null)
    var _rtIRDecodedImages = [];    // pre-decoded Image objects
    var _rtIRAnimFrame = 0;
    var _rtIRAnimTimer = null;
    var _rtIRAnimPlaying = false;
    var _rtIRPlotlyVisible = false;
    var _rtIRAllLoaded = false;
    var _rtIRLoadedCount = 0;
    var _rtIRFetching = false;

    // Leaflet map state
    var _rtMap = null;
    var _rtMapMarker = null;
    var _rtIRMapOverlay = null;
    var _rtIRMapVisible = true;
    var _rtIRMapBoundsSet = false;
    var _rtMaxWind2km = null;

    // ── Tab visibility toggle ────────────────────────────────────
    window.toggleRealtimeTab = function () {
        var section = document.getElementById('realtime-section');
        var archiveSections = document.querySelectorAll('#map-section, #about, #features, #download, #contact, footer');
        _rtVisible = !_rtVisible;

        if (_rtVisible) {
            // Hide archive, show real-time
            archiveSections.forEach(function (el) { el.style.display = 'none'; });
            section.style.display = 'block';
            // Update nav link style
            var link = document.getElementById('rt-nav-link');
            if (link) link.classList.add('active');
            // Load missions if not yet loaded
            if (!document.getElementById('rt-mission-select').options.length ||
                document.getElementById('rt-mission-select').options[0].value === '') {
                loadMissions();
            }
        } else {
            // Show archive, hide real-time
            archiveSections.forEach(function (el) { el.style.display = ''; });
            section.style.display = 'none';
            var link2 = document.getElementById('rt-nav-link');
            if (link2) link2.classList.remove('active');
        }
    };

    window.showArchiveTab = function () {
        if (_rtVisible) toggleRealtimeTab();
    };

    // ── Toast (reuse if available, otherwise standalone) ─────────
    function rtToast(message, type, duration) {
        if (typeof showToast === 'function') { showToast(message, type, duration); return; }
        type = type || 'info'; duration = duration || 5000;
        var container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = 'position:fixed;top:60px;right:16px;z-index:100000;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
            document.body.appendChild(container);
        }
        var toast = document.createElement('div');
        var bgColor = type === 'error' ? 'rgba(239,68,68,0.95)' : type === 'warn' ? 'rgba(245,158,11,0.95)' : 'rgba(14,45,90,0.95)';
        toast.style.cssText = 'background:' + bgColor + ';color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-family:DM Sans,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.4);border:1px solid rgba(96,165,250,0.4);pointer-events:auto;max-width:380px;opacity:0;transform:translateX(30px);transition:all 0.3s ease;';
        toast.textContent = message;
        container.appendChild(toast);
        requestAnimationFrame(function () { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
        setTimeout(function () { toast.style.opacity = '0'; toast.style.transform = 'translateX(30px)'; setTimeout(function () { toast.remove(); }, 300); }, duration);
    }

    // ── Hurricane loading animation (reuse pattern from main app) ──
    function _rtLoadingHTML(msg) {
        return '<div class="explorer-status loading" style="padding:24px 0;text-align:center;">' +
            '<div class="spinner" style="margin:0 auto 12px;"></div>' +
            '<div>' + msg + '</div></div>';
    }

    // ── Load mission list ────────────────────────────────────────
    function loadMissions() {
        var sel = document.getElementById('rt-mission-select');
        sel.innerHTML = '<option value="">Loading missions…</option>';
        sel.disabled = true;

        fetch(API_BASE + RT_PREFIX + '/missions')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                sel.innerHTML = '<option value="">Select a mission…</option>';
                json.missions.forEach(function (m) {
                    var opt = document.createElement('option');
                    opt.value = m;
                    // Parse a readable label: e.g. "20251028H1" → "2025-10-28 H1"
                    var label = m;
                    var match = m.match(/^(\d{4})(\d{2})(\d{2})(.+)$/);
                    if (match) label = match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4];
                    opt.textContent = label;
                    sel.appendChild(opt);
                });
                sel.disabled = false;
            })
            .catch(function (err) {
                sel.innerHTML = '<option value="">Error loading missions</option>';
                rtToast('Could not load missions: ' + err.message, 'error');
            });
    }
    window._rtLoadMissions = loadMissions;

    // ── Load files for a mission ─────────────────────────────────
    function loadFiles(mission) {
        var sel = document.getElementById('rt-file-select');
        var goBtn = document.getElementById('rt-go-btn');
        sel.innerHTML = '<option value="">Loading files…</option>';
        sel.disabled = true;
        goBtn.disabled = true;

        fetch(API_BASE + RT_PREFIX + '/files?mission=' + encodeURIComponent(mission))
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                sel.innerHTML = '<option value="">Select an analysis…</option>';
                if (json.files.length === 0) {
                    sel.innerHTML = '<option value="">No xy analysis files found</option>';
                    return;
                }
                json.files.forEach(function (f) {
                    var opt = document.createElement('option');
                    opt.value = f.url;
                    var timeStr = f.time_label;
                    if (timeStr.length === 4) {
                        timeStr = timeStr.substring(0, 2) + ':' + timeStr.substring(2) + ' UTC';
                    }
                    opt.textContent = timeStr + '  (' + f.filename + ')';
                    sel.appendChild(opt);
                });
                sel.disabled = false;
            })
            .catch(function (err) {
                sel.innerHTML = '<option value="">Error loading files</option>';
                rtToast('Could not list files: ' + err.message, 'error');
            });
    }

    // ── Event: mission selected ──────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        var missionSel = document.getElementById('rt-mission-select');
        var fileSel = document.getElementById('rt-file-select');
        var goBtn = document.getElementById('rt-go-btn');

        if (missionSel) {
            missionSel.addEventListener('change', function () {
                if (this.value) loadFiles(this.value);
                else {
                    fileSel.innerHTML = '<option value="">← Select a mission first</option>';
                    fileSel.disabled = true;
                    goBtn.disabled = true;
                }
            });
        }
        if (fileSel) {
            fileSel.addEventListener('change', function () {
                goBtn.disabled = !this.value;
            });
        }
    });

    // ── Go button: load the file and show viz panel ──────────────
    window.rtExploreFile = function () {
        var fileUrl = document.getElementById('rt-file-select').value;
        if (!fileUrl) return;
        _currentFileUrl = fileUrl;
        _rtDataCache = {};
        _rtLast3DJson = null;
        _rtLastPlotlyData = null;
        _rtCsMode = false;
        _rtCsPointA = null;
        _rtRemoveRubberBand();

        // Reset IR state + Leaflet map
        rtIRCleanup();
        _rtCleanupMap();

        // Show the viz panel
        var panel = document.getElementById('rt-viz-panel');
        panel.style.display = 'block';

        // Reset display
        document.getElementById('rt-display-area').innerHTML = _rtLoadingHTML('Loading TDR analysis… (may take ~30s for first file)');
        document.getElementById('rt-meta-panel').innerHTML = '';
        document.getElementById('rt-cs-result').innerHTML = '';
        document.getElementById('rt-cs-status').textContent = '';
        var azResult = document.getElementById('rt-az-result'); if (azResult) azResult.innerHTML = '';

        // Disable action buttons until plot renders
        var csBtn = document.getElementById('rt-cs-btn'); if (csBtn) csBtn.disabled = true;
        var volBtn = document.getElementById('rt-vol-btn'); if (volBtn) volBtn.disabled = true;
        var azBtn = document.getElementById('rt-az-btn'); if (azBtn) azBtn.disabled = true;

        // Generate initial plot
        rtGeneratePlot();

        // Fetch metadata display
        rtFetchMeta(fileUrl);

        // Fetch GOES IR satellite imagery in parallel
        _rtShowIRLoadingIndicator();
        rtFetchIR();
    };

    // ── Fetch and display metadata ───────────────────────────────
    function rtFetchMeta(fileUrl) {
        fetch(API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(fileUrl) + '&variable=' + DEFAULT_RT_VAR + '&level_km=2')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                var m = json.case_meta || {};
                var html = '<div class="rt-meta-title">' + (m.storm_name || 'Unknown') + '</div>' +
                    '<div class="rt-meta-row">' + (m.mission_id || '') + ' · ' + (m.datetime || '') + '</div>' +
                    '<div class="rt-meta-grid">' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Position</span><span class="rt-meta-val">' +
                    (m.latitude ? m.latitude.toFixed(2) + '°N, ' + Math.abs(m.longitude).toFixed(2) + '°' + (m.longitude < 0 ? 'W' : 'E') : '—') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Radar</span><span class="rt-meta-val">' + (m.radar || 'TAIL') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Resolution</span><span class="rt-meta-val">' + (m.resolution_km || 2) + ' km</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Storm Motion</span><span class="rt-meta-val">' +
                    (m.storm_motion_north_ms > -999 ? m.storm_motion_north_ms.toFixed(1) + ' N, ' + m.storm_motion_east_ms.toFixed(1) + ' E m/s' : '—') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Melting Level</span><span class="rt-meta-val">' +
                    (m.melting_height_km > 0 ? m.melting_height_km.toFixed(1) + ' km' : '—') + '</span></div>' +
                    '<div class="rt-meta-item"><span class="rt-meta-label">Quality</span><span class="rt-meta-val">' +
                    (m.analysis_level === '1' ? 'Real-Time' : m.analysis_level === '2' ? 'Research' : m.analysis_level || '—') + '</span></div>' +
                    '</div>';
                document.getElementById('rt-meta-panel').innerHTML = html;

                // Init Leaflet map + fetch max 2-km wind for marker
                if (m.latitude && m.longitude) {
                    _rtInitMap(m);
                    _rtFetchMaxWind(_currentFileUrl, m);
                }
            })
            .catch(function () { /* metadata will show from the plot fetch anyway */ });
    }

    // ── Default variable ─────────────────────────────────────────
    var DEFAULT_RT_VAR = 'TANGENTIAL_WIND';

    // ── Generate plan-view plot ──────────────────────────────────
    window.rtGeneratePlot = function (callback) {
        if (!_currentFileUrl) return;
        var variable = document.getElementById('rt-var').value;
        var level_km = document.getElementById('rt-level').value;
        var overlay = (document.getElementById('rt-overlay') || {}).value || '';
        var resultDiv = document.getElementById('rt-display-area');
        var btn = document.getElementById('rt-gen-btn');
        btn.disabled = true; btn.textContent = 'Generating…';

        // Clear dependent results
        document.getElementById('rt-cs-result').innerHTML = '';
        document.getElementById('rt-cs-status').textContent = '';
        var azResult = document.getElementById('rt-az-result'); if (azResult) azResult.innerHTML = '';

        if (!_rtAnimPlaying) {
            resultDiv.innerHTML = _rtLoadingHTML('Fetching data from API…');
        }

        var cacheKey = _currentFileUrl + '_' + variable + '_' + level_km + '_' + overlay;
        if (_rtDataCache[cacheKey]) {
            rtRenderPlot(_rtDataCache[cacheKey], resultDiv);
            btn.disabled = false; btn.textContent = 'Generate Plot';
            if (callback) callback(); return;
        }

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        var url = API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(_currentFileUrl) + '&variable=' + variable + '&level_km=' + level_km;
        if (overlay) url += '&overlay=' + overlay;

        fetch(url, { signal: controller.signal })
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) { _rtDataCache[cacheKey] = json; rtRenderPlot(json, resultDiv); if (callback) callback(); })
            .catch(function (err) {
                var msg = err.name === 'AbortError' ? '⚠️ Request timed out (120s).' : '⚠️ ' + err.message;
                resultDiv.innerHTML = '<div class="explorer-status error">' + msg + '</div>';
                rtAnimStop();
            })
            .finally(function () { clearTimeout(timeout); btn.disabled = false; btn.textContent = 'Generate Plot'; });
    };

    // ── Max value helpers (mirrors archive findDataMax / buildMaxMarkerTrace / buildMaxAnnotation) ──
    function rtFindDataMax(zData, xCoords, yCoords) {
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

    function rtIsWindVariable(varName) {
        return varName && varName.toLowerCase().indexOf('wind') !== -1;
    }

    function rtBuildMaxMarkerTrace(maxInfo, units) {
        if (!maxInfo) return null;
        return {
            x: [maxInfo.x], y: [maxInfo.y], type: 'scatter', mode: 'markers',
            marker: { symbol: 'x', size: 10, color: 'white', line: { color: 'rgba(0,0,0,0.6)', width: 1.5 } },
            hoverinfo: 'text',
            hovertext: ['Max: ' + maxInfo.value.toFixed(2) + ' ' + units + '\n@ (' + maxInfo.x.toFixed(0) + ', ' + maxInfo.y.toFixed(0) + ')'],
            showlegend: false
        };
    }

    function rtBuildMaxAnnotation(maxInfo, units, xLabel, yLabel, fontSize) {
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

    // ── Rubber-band line for cross-section (follows mouse from A to cursor) ──
    function _rtStartRubberBand(plotDiv, pxA, pyA) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'rt-cs-rubber-band';
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
        _rtCsMouseHandler = function (e) {
            var rect = plotDiv.getBoundingClientRect();
            line.setAttribute('x2', e.clientX - rect.left);
            line.setAttribute('y2', e.clientY - rect.top);
            circle.setAttribute('cx', e.clientX - rect.left);
            circle.setAttribute('cy', e.clientY - rect.top);
        };
        plotDiv.addEventListener('mousemove', _rtCsMouseHandler);
    }

    function _rtRemoveRubberBand() {
        var svg = document.getElementById('rt-cs-rubber-band');
        if (svg) svg.remove();
        if (_rtCsMouseHandler) {
            var plotDiv = document.getElementById('rt-plotly-chart');
            if (plotDiv) plotDiv.removeEventListener('mousemove', _rtCsMouseHandler);
            _rtCsMouseHandler = null;
        }
    }

    // ── Default colormap helper: returns 'Jet' for tangential wind / wind speed ──
    function _rtDefaultCmapForVariable(varName) {
        if (varName === 'TANGENTIAL_WIND' || varName === 'WIND_SPEED') return 'Jet';
        return null; // use server default
    }

    // ── Render plan-view from JSON ───────────────────────────────
    function rtRenderPlot(json, resultDiv) {
        resultDiv.innerHTML = '<div style="position:relative;"><div id="rt-plotly-chart" style="width:100%;height:400px;border-radius:6px;overflow:hidden;"></div>' +
            '<button onclick="rtOpenFullscreen()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">⛶</button></div>' +
            '<div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover for values · scroll to zoom · drag to pan · ⛶ expand</div>';

        var zData = json.data, x = json.x, y = json.y, varInfo = json.variable, meta = json.case_meta || {};
        _rtDefaultColorscale = varInfo.colorscale;
        _rtDefaultVmin = varInfo.vmin;
        _rtDefaultVmax = varInfo.vmax;

        // Determine active colorscale: user override > variable-specific default > server default
        var cmapSel = document.getElementById('rt-cmap');
        var activeColorscale = varInfo.colorscale;
        var varDefault = _rtDefaultCmapForVariable(varInfo.key || (document.getElementById('rt-var') || {}).value || '');
        if (cmapSel && cmapSel.value) { try { activeColorscale = JSON.parse(cmapSel.value); } catch (e) { activeColorscale = cmapSel.value; } }
        else if (varDefault) { activeColorscale = varDefault; }

        var activeVmin = _rtGetVmin(), activeVmax = _rtGetVmax();
        var title = (meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || '') +
            '<br>' + varInfo.display_name + ' @ ' + json.actual_level_km.toFixed(1) + ' km';
        if (json.overlay) title += '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>';

        var heatmap = {
            z: zData, x: x, y: y, type: 'heatmap',
            colorscale: activeColorscale,
            zmin: activeVmin, zmax: activeVmax,
            colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 12, len: 0.85 },
            hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>X: %{x:.0f} km<br>Y: %{y:.0f} km<extra></extra>',
            hoverongaps: false
        };

        var plotBg = '#0a1628';
        var baseLayout = {
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false, scaleanchor: 'y' },
            yaxis: { title: { text: 'Northward distance (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
            showlegend: false
        };
        var layout = Object.assign({}, baseLayout, {
            title: { text: title, font: { color: '#e5e7eb', size: 11 }, y: 0.98, x: 0.5, xanchor: 'center' },
            margin: { l: 52, r: 16, t: json.overlay ? 82 : 66, b: 44 }
        });

        var overlayTraces = rtBuildOverlayContours(json, x, y, false);
        var config = { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'], displaylogo: false };

        // Max value marker + annotation (mirrors archive renderPlotFromJSON)
        var maxInfo = rtFindDataMax(zData, x, y);
        var maxTraces = [];
        if (maxInfo) {
            var maxAnnot = rtBuildMaxAnnotation(maxInfo, varInfo.units, 'X', 'Y', 9);
            if (maxAnnot) {
                layout.annotations = (layout.annotations || []).concat([maxAnnot]);
                baseLayout.annotations = (baseLayout.annotations || []).concat([maxAnnot]);
            }
            var currentVar = (document.getElementById('rt-var') || {}).value || '';
            if (rtIsWindVariable(currentVar)) {
                var maxMarker = rtBuildMaxMarkerTrace(maxInfo, varInfo.units);
                if (maxMarker) maxTraces.push(maxMarker);
            }
        }

        Plotly.newPlot('rt-plotly-chart', [heatmap].concat(overlayTraces).concat(maxTraces), layout, config);
        _rtLastPlotlyData = { heatmap: heatmap, overlayTraces: overlayTraces, maxTraces: maxTraces, baseLayout: baseLayout, title: title, config: config, json: json };

        // Enable action buttons
        var csBtn = document.getElementById('rt-cs-btn'); if (csBtn) csBtn.disabled = false;
        var volBtn = document.getElementById('rt-vol-btn'); if (volBtn) volBtn.disabled = false;
        var azBtn = document.getElementById('rt-az-btn'); if (azBtn) azBtn.disabled = false;

        // Click handler for cross-section
        document.getElementById('rt-plotly-chart').on('plotly_click', rtHandlePlotClick);
    }

    // ── Overlay contours ─────────────────────────────────────────
    function rtBuildOverlayContours(json, x, y, isCS) {
        if (!json.overlay) return [];
        var ov = json.overlay;
        var ovData = isCS ? ov.cross_section : ov.data;
        if (!ovData) return [];
        try {
            var intInput = document.getElementById('rt-contour-int');
            var interval = intInput ? parseFloat(intInput.value) : NaN;
            if (isNaN(interval) || interval <= 0) {
                var flat = ovData.flat().filter(function (v) { return v !== null && !isNaN(v); });
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
            if (ov.vmin < -interval) traces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, hovertemplate: '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>', name: ov.display_name + ' (−)', showlegend: false }));
            return traces;
        } catch (e) { return []; }
    }

    // ── Colormap / color range helpers ───────────────────────────
    function _rtGetVmin() { var inp = document.getElementById('rt-vmin'); if (inp && inp.value !== '') return parseFloat(inp.value); return _rtDefaultVmin; }
    function _rtGetVmax() { var inp = document.getElementById('rt-vmax'); if (inp && inp.value !== '') return parseFloat(inp.value); return _rtDefaultVmax; }

    window.rtApplyCmap = function () {
        var sel = document.getElementById('rt-cmap'); if (!sel) return;
        var cs = sel.value;
        if (!cs && _rtDefaultColorscale) cs = _rtDefaultColorscale; if (!cs) return;
        var colorscale; try { colorscale = JSON.parse(cs); } catch (e) { colorscale = cs; }
        ['rt-plotly-chart', 'rt-fullscreen-chart', 'rt-cs-fullscreen'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.data && el.data.length) Plotly.restyle(el, { colorscale: [colorscale] }, [0]);
        });
    };

    window.rtApplyColorRange = function () {
        var zmin = _rtGetVmin(), zmax = _rtGetVmax(); if (zmin === null || zmax === null) return;
        ['rt-plotly-chart', 'rt-fullscreen-chart', 'rt-cs-fullscreen'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.data && el.data.length) Plotly.restyle(el, { zmin: [zmin], zmax: [zmax] }, [0]);
        });
    };

    window.rtResetColorRange = function () {
        var vi = document.getElementById('rt-vmin'), va = document.getElementById('rt-vmax');
        if (vi) vi.value = ''; if (va) va.value = '';
        if (_rtDefaultVmin !== null && _rtDefaultVmax !== null) {
            ['rt-plotly-chart', 'rt-fullscreen-chart', 'rt-cs-fullscreen'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el && el.data && el.data.length) Plotly.restyle(el, { zmin: [_rtDefaultVmin], zmax: [_rtDefaultVmax] }, [0]);
            });
        }
    };

    // ── Fullscreen modal (reuse the existing plotModal) ──────────
    window.rtOpenFullscreen = function () {
        if (!_rtLastPlotlyData) return;
        var modal = document.getElementById('plotModal');
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        var d = _rtLastPlotlyData;
        var fullLayout = Object.assign({}, d.baseLayout, {
            title: { text: d.title, font: { color: '#e5e7eb', size: 14 }, y: 0.97, x: 0.5, xanchor: 'center' },
            margin: { l: 60, r: 28, t: 80, b: 52 }
        });

        // Hide cross-section panes from main app
        var csFull = document.getElementById('cs-fullscreen'); if (csFull) csFull.style.display = 'none';
        var azFull = document.getElementById('az-fullscreen'); if (azFull) azFull.style.display = 'none';
        var csDiv = document.getElementById('cs-full-divider'); if (csDiv) csDiv.style.display = 'none';
        var azDiv = document.getElementById('az-full-divider'); if (azDiv) azDiv.style.display = 'none';

        Plotly.newPlot('plotly-fullscreen', [d.heatmap].concat(d.overlayTraces).concat(d.maxTraces || []), fullLayout, d.config);
        document.getElementById('plotly-fullscreen').on('plotly_click', rtHandlePlotClick);
    };

    // ── Height animation ─────────────────────────────────────────
    window.rtAnimToggle = function () { if (_rtAnimPlaying) rtAnimStop(); else rtAnimStart(); };
    function rtAnimStart() {
        _rtAnimPlaying = true;
        var btn = document.getElementById('rt-anim-play'); if (btn) { btn.textContent = '⏸'; btn.classList.add('active'); }
        rtAnimTick();
    }
    function rtAnimStop() {
        _rtAnimPlaying = false;
        if (_rtAnimTimer) { clearTimeout(_rtAnimTimer); _rtAnimTimer = null; }
        var btn = document.getElementById('rt-anim-play'); if (btn) { btn.textContent = '▶'; btn.classList.remove('active'); }
    }
    function rtAnimTick() {
        if (!_rtAnimPlaying) return;
        rtGeneratePlot(function () {
            if (!_rtAnimPlaying) return;
            _rtAnimTimer = setTimeout(function () { rtAnimStep(1); rtAnimTick(); }, 800);
        });
    }
    window.rtAnimStep = function (dir) {
        var slider = document.getElementById('rt-level'); if (!slider) return;
        var val = parseFloat(slider.value) + dir * 0.5;
        if (val > 18) val = 0; if (val < 0) val = 18;
        slider.value = val;
        document.getElementById('rt-level-val').textContent = val.toFixed(1) + ' km';
        if (!_rtAnimPlaying) rtGeneratePlot();
    };

    // ── Cross-section ────────────────────────────────────────────
    window.rtToggleCrossSection = function () {
        _rtCsMode = !_rtCsMode; _rtCsPointA = null; _rtRemoveRubberBand();
        var btn = document.getElementById('rt-cs-btn'), status = document.getElementById('rt-cs-status');
        if (_rtCsMode) {
            btn.classList.add('active'); btn.textContent = '✂ Click point A on plot…';
            if (status) status.textContent = 'Click the starting point on the plan view above';
        } else {
            btn.classList.remove('active'); btn.textContent = '✂ Cross Section';
            if (status) status.textContent = '';
        }
    };

    function rtHandlePlotClick(eventData) {
        if (!_rtCsMode || !eventData.points || !eventData.points.length) return;
        var pt = eventData.points[0], x = pt.x, y = pt.y;
        var status = document.getElementById('rt-cs-status');
        var plotDiv = document.getElementById('rt-plotly-chart');

        if (!_rtCsPointA) {
            _rtCsPointA = { x: x, y: y };
            var btn = document.getElementById('rt-cs-btn'); if (btn) btn.textContent = '✂ Click point B…';
            if (status) status.textContent = 'A: (' + x.toFixed(0) + ', ' + y.toFixed(0) + ') km — now click end point';
            var shapes = (plotDiv.layout.shapes || []).slice();
            shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: x - 4, y0: y - 4, x1: x + 4, y1: y + 4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } });
            Plotly.relayout(plotDiv, { shapes: shapes });
            // Start rubber-band line from Point A to cursor
            var rect = plotDiv.getBoundingClientRect();
            _rtStartRubberBand(plotDiv, eventData.event.clientX - rect.left, eventData.event.clientY - rect.top);
        } else {
            var a = _rtCsPointA, b = { x: x, y: y };
            _rtCsMode = false; _rtCsPointA = null; _rtRemoveRubberBand();
            var btn2 = document.getElementById('rt-cs-btn'); if (btn2) { btn2.classList.remove('active'); btn2.textContent = '✂ Cross Section'; }
            if (status) status.textContent = 'A→B: (' + a.x.toFixed(0) + ',' + a.y.toFixed(0) + ') → (' + b.x.toFixed(0) + ',' + b.y.toFixed(0) + ') km';
            var shapes2 = (plotDiv.layout.shapes || []).slice();
            shapes2.push(
                { type: 'line', xref: 'x', yref: 'y', x0: a.x, y0: a.y, x1: b.x, y1: b.y, line: { color: '#ef4444', width: 2.5 } },
                { type: 'circle', xref: 'x', yref: 'y', x0: b.x - 4, y0: b.y - 4, x1: b.x + 4, y1: b.y + 4, fillcolor: '#ef4444', line: { color: 'white', width: 1.5 } }
            );
            Plotly.relayout(plotDiv, { shapes: shapes2 });
            rtFetchCrossSection(a, b);
        }
    }

    function rtFetchCrossSection(a, b) {
        var variable = document.getElementById('rt-var').value;
        var overlay = (document.getElementById('rt-overlay') || {}).value || '';
        var csResult = document.getElementById('rt-cs-result');
        csResult.innerHTML = _rtLoadingHTML('Computing cross-section…');

        var url = API_BASE + RT_PREFIX + '/cross_section?file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + variable + '&x0=' + a.x + '&y0=' + a.y + '&x1=' + b.x + '&y1=' + b.y + '&n_points=150';
        if (overlay) url += '&overlay=' + overlay;

        fetch(url)
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) {
                csResult.innerHTML = '<div class="explorer-status" style="color:#10b981;">✓ Cross-section ready</div>';
                rtRenderCrossSection(json);
            })
            .catch(function (err) { csResult.innerHTML = '<div class="explorer-status error">⚠️ ' + err.message + '</div>'; });
    }

    function rtRenderCrossSection(json) {
        // Render inline below the plan view
        var csResult = document.getElementById('rt-cs-result');
        csResult.innerHTML = '<div id="rt-cs-chart" style="width:100%;height:300px;border-radius:6px;overflow:hidden;margin-top:8px;"></div>';

        var csData = json.cross_section, dist = json.distance_km, hgt = json.height_km, vi = json.variable, ep = json.endpoints;

        var cmapSel = document.getElementById('rt-cmap');
        var csColorscale = vi.colorscale;
        var csVarDefault = _rtDefaultCmapForVariable(vi.key || (document.getElementById('rt-var') || {}).value || '');
        if (cmapSel && cmapSel.value) { try { csColorscale = JSON.parse(cmapSel.value); } catch (e) { csColorscale = cmapSel.value; } }
        else if (csVarDefault) { csColorscale = csVarDefault; }
        var av = _rtGetVmin(), avx = _rtGetVmax();

        var heatmap = {
            z: csData, x: dist, y: hgt, type: 'heatmap',
            colorscale: csColorscale,
            zmin: av !== null ? av : vi.vmin,
            zmax: avx !== null ? avx : vi.vmax,
            colorbar: { title: { text: vi.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 10, len: 0.85 },
            hovertemplate: '<b>' + vi.display_name + '</b>: %{z:.2f} ' + vi.units + '<br>Distance: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false
        };

        var title = 'Cross Section: (' + ep.x0.toFixed(0) + ',' + ep.y0.toFixed(0) + ') → (' + ep.x1.toFixed(0) + ',' + ep.y1.toFixed(0) + ') km';
        var plotBg = '#0a1628';
        var layout = {
            title: { text: title, font: { color: '#e5e7eb', size: 11 }, y: 0.97, x: 0.5, xanchor: 'center' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Distance along line (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            margin: { l: 45, r: 12, t: 44, b: 38 },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 11 } },
            showlegend: false
        };

        var csOverlays = rtBuildOverlayContours(json, null, null, true);
        Plotly.newPlot('rt-cs-chart', [heatmap].concat(csOverlays), layout, { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'] });
    }

    // ── 3D Volume ────────────────────────────────────────────────
    window.rtFetch3DVolume = function () {
        if (!_currentFileUrl) return;
        var variable = document.getElementById('rt-var').value;
        var btn = document.getElementById('rt-vol-btn');
        btn.disabled = true; btn.textContent = '🖥 Loading…';

        var cacheKey = '3d_rt_' + _currentFileUrl + '_' + variable;
        if (_rtDataCache[cacheKey]) {
            _rtLast3DJson = _rtDataCache[cacheKey];
            rtOpen3DModal();
            btn.disabled = false; btn.textContent = '🖥 3D Volume';
            return;
        }

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        var url = API_BASE + RT_PREFIX + '/volume?file_url=' + encodeURIComponent(_currentFileUrl) + '&variable=' + variable + '&stride=2&max_height_km=15';

        fetch(url, { signal: controller.signal })
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) {
                _rtDataCache[cacheKey] = json;
                _rtLast3DJson = json;
                rtOpen3DModal();
            })
            .catch(function (err) {
                var msg = err.name === 'AbortError' ? 'Request timed out (120s).' : err.message;
                rtToast('3D Volume: ' + msg, 'error');
            })
            .finally(function () { clearTimeout(timeout); btn.disabled = false; btn.textContent = '🖥 3D Volume'; });
    };

    function rtOpen3DModal() {
        if (!_rtLast3DJson) return;
        // Reuse the existing vol3DModal from index.html
        // Store and swap the global _last3DJson temporarily
        var saved = window._last3DJson;
        window._last3DJson = _rtLast3DJson;

        // Call the existing open3DModal function if available
        if (typeof open3DModal === 'function') {
            open3DModal();
        }
        // Note: we don't restore saved because the modal references _last3DJson
        // while it's open. It'll be overwritten next time the archive mode uses it.
    }

    // ══════════════════════════════════════════════════════════════
    // Leaflet Map + IR Overlay Module
    // ══════════════════════════════════════════════════════════════

    // Wind-speed intensity color (m/s thresholds, mirrors archive kt thresholds)
    function _rtWindColor(wspd_ms) {
        if (wspd_ms == null || isNaN(wspd_ms)) return '#6b7280';
        if (wspd_ms < 17.5) return '#60a5fa';  // TD
        if (wspd_ms < 33.0) return '#34d399';  // TS
        if (wspd_ms < 43.0) return '#fbbf24';  // Cat 1
        if (wspd_ms < 49.5) return '#fb923c';  // Cat 2
        if (wspd_ms < 58.0) return '#f87171';  // Cat 3
        if (wspd_ms < 70.5) return '#ef4444';  // Cat 4
        return '#dc2626';                       // Cat 5
    }
    function _rtWindCategory(wspd_ms) {
        if (wspd_ms == null || isNaN(wspd_ms)) return '';
        if (wspd_ms < 17.5) return 'TD';
        if (wspd_ms < 33.0) return 'TS';
        if (wspd_ms < 43.0) return 'Cat 1';
        if (wspd_ms < 49.5) return 'Cat 2';
        if (wspd_ms < 58.0) return 'Cat 3';
        if (wspd_ms < 70.5) return 'Cat 4';
        return 'Cat 5';
    }

    function _rtInitMap(meta) {
        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;

        if (_rtMap) {
            // Recenter existing map
            _rtMap.setView([meta.latitude, meta.longitude], 6, { animate: true });
            return;
        }

        _rtMap = L.map('rt-map', {
            center: [meta.latitude, meta.longitude],
            zoom: 6,
            zoomControl: true
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 12
        }).addTo(_rtMap);
    }

    function _rtUpdateMapMarker(meta, maxWind) {
        if (!_rtMap) return;
        if (_rtMapMarker) { _rtMap.removeLayer(_rtMapMarker); _rtMapMarker = null; }

        var color = _rtWindColor(maxWind);
        var cat = _rtWindCategory(maxWind);
        var icon = L.divIcon({
            className: 'custom-div-icon',
            html: '<div class="custom-marker" style="background-color:' + color +
                ';width:16px;height:16px;box-shadow:0 0 0 4px rgba(37,99,235,0.35);border-radius:50%;"></div>',
            iconSize: [16, 16], iconAnchor: [8, 8]
        });

        _rtMapMarker = L.marker([meta.latitude, meta.longitude], { icon: icon }).addTo(_rtMap);

        var windStr = maxWind != null ? maxWind.toFixed(1) + ' m/s' : 'N/A';
        var catStr = cat ? ' (' + cat + ')' : '';
        var popupHtml =
            '<div style="font-family:DM Sans,sans-serif;font-size:12px;line-height:1.5;min-width:180px;">' +
            '<strong style="font-size:14px;color:' + color + ';">' + (meta.storm_name || 'Unknown') + '</strong><br>' +
            '<span style="color:#aaa;">' + (meta.mission_id || '') + ' · ' + (meta.datetime || '') + '</span><br>' +
            '<span style="margin-top:4px;display:inline-block;">Max 2-km Wind: <strong style="color:' + color + ';">' + windStr + catStr + '</strong></span><br>' +
            '<span style="color:#aaa;font-size:10px;">' +
            (meta.latitude ? meta.latitude.toFixed(2) + '°N, ' + Math.abs(meta.longitude).toFixed(2) + '°' + (meta.longitude < 0 ? 'W' : 'E') : '') +
            '</span></div>';
        _rtMapMarker.bindPopup(popupHtml, { maxWidth: 280, minWidth: 200 });
    }

    function _rtFetchMaxWind(fileUrl, meta) {
        // Fetch WIND_SPEED at 2 km to get max wind for the marker
        var url = API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(fileUrl) +
            '&variable=WIND_SPEED&level_km=2';
        fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                var maxVal = -Infinity;
                var zData = json.data;
                for (var i = 0; i < zData.length; i++) {
                    if (!zData[i]) continue;
                    for (var j = 0; j < zData[i].length; j++) {
                        var v = zData[i][j];
                        if (v !== null && v !== undefined && isFinite(v) && v > maxVal) maxVal = v;
                    }
                }
                _rtMaxWind2km = isFinite(maxVal) ? maxVal : null;
                _rtUpdateMapMarker(meta, _rtMaxWind2km);
            })
            .catch(function () {
                _rtMaxWind2km = null;
                _rtUpdateMapMarker(meta, null);
            });
    }

    // ── IR overlay on Leaflet map ────────────────────────────────
    function _rtShowIROnMap(frameIdx) {
        if (!_rtMap || !_rtIRData || !_rtIRFrameURLs.length) return;
        var idx = (frameIdx !== undefined) ? frameIdx : _rtIRAnimFrame;
        idx = Math.max(0, Math.min(idx, _rtIRFrameURLs.length - 1));
        var url = _rtIRFrameURLs[idx];
        if (!url) return;

        var bd = _rtIRData.bounds_deg;
        if (!bd) return;
        var bounds = L.latLngBounds(
            [bd.lat_min, bd.lon_min],
            [bd.lat_max, bd.lon_max]
        );

        if (_rtIRMapOverlay) {
            // Fast path: swap image src directly (most reliable for data-URLs)
            var imgEl = _rtIRMapOverlay.getElement ? _rtIRMapOverlay.getElement() : _rtIRMapOverlay._image;
            if (imgEl) { imgEl.src = url; }
            else { _rtIRMapOverlay.setUrl(url); }
            if (!_rtIRMapBoundsSet) {
                _rtIRMapOverlay.setBounds(bounds);
                _rtIRMapBoundsSet = true;
            }
        } else {
            _rtIRMapOverlay = L.imageOverlay(url, bounds, {
                opacity: 0.75, interactive: false, zIndex: 200
            });
            if (_rtIRMapVisible) _rtIRMapOverlay.addTo(_rtMap);
            _rtIRMapBoundsSet = true;
        }
    }

    function _rtRemoveIRFromMap() {
        if (_rtIRMapOverlay && _rtMap) {
            _rtMap.removeLayer(_rtIRMapOverlay);
            _rtIRMapOverlay = null;
        }
        _rtIRMapBoundsSet = false;
        // Remove map IR controls
        var ctrl = document.getElementById('rt-map-ir-controls');
        if (ctrl) ctrl.remove();
    }

    window.rtToggleMapIRVisibility = function () {
        _rtIRMapVisible = !_rtIRMapVisible;
        if (_rtIRMapVisible && _rtIRMapOverlay) {
            _rtIRMapOverlay.addTo(_rtMap);
        } else if (!_rtIRMapVisible && _rtIRMapOverlay && _rtMap) {
            _rtMap.removeLayer(_rtIRMapOverlay);
        }
        var btn = document.getElementById('rt-map-ir-toggle');
        if (btn) btn.textContent = _rtIRMapVisible ? '🌍 IR On' : '🌑 IR Off';
    };

    window.rtMapIRAnimStep = function (dir) {
        if (!_rtIRData || _rtIRLoadedCount < 2) return;
        var n = _rtIRFrameURLs.length;
        for (var i = 0; i < n; i++) {
            _rtIRAnimFrame = (_rtIRAnimFrame + dir + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        _rtShowIROnMap(_rtIRAnimFrame);
        rtIRShowFrame(_rtIRAnimFrame);
        _rtUpdateMapIRSlider();
    };

    function _rtUpdateMapIRSlider() {
        var slider = document.getElementById('rt-map-ir-slider');
        var label = document.getElementById('rt-map-ir-label');
        if (!_rtIRData) return;
        var n = _rtIRData.n_frames || 17;
        if (slider) slider.value = (n - 1) - _rtIRAnimFrame;
        if (label && _rtIRData.frame_datetimes && _rtIRData.frame_datetimes[_rtIRAnimFrame]) {
            var lag = _rtIRData.lag_minutes ? _rtIRData.lag_minutes[_rtIRAnimFrame] : 0;
            var lagStr = lag === 0 ? 't=0' : 't−' + Math.floor(lag / 60) + ':' + ('0' + (lag % 60)).slice(-2);
            label.textContent = 'IR ' + lagStr + ' | ' + _rtIRData.frame_datetimes[_rtIRAnimFrame];
        }
    }

    function _rtInjectMapIRControls() {
        if (document.getElementById('rt-map-ir-controls')) return;
        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;
        var n = _rtIRFrameURLs.length;
        var disabledCls = _rtIRAllLoaded ? '' : ' rt-ir-ctrl-disabled';
        var disabledAttr = _rtIRAllLoaded ? '' : ' disabled';
        var ctrl = document.createElement('div');
        ctrl.id = 'rt-map-ir-controls';
        ctrl.className = 'rt-map-ir-controls';
        ctrl.innerHTML =
            '<div class="ir-ctrl-row">' +
                '<button class="ir-ctrl-btn" id="rt-map-ir-toggle" onclick="rtToggleMapIRVisibility()">🌍 IR On</button>' +
                '<button class="ir-ctrl-btn' + disabledCls + '" id="rt-map-ir-step-back" onclick="rtMapIRAnimStep(1)" title="Earlier">◀</button>' +
                '<button class="ir-ctrl-btn' + disabledCls + '" id="rt-map-ir-play" onclick="rtMapIRAnimToggle()" title="Play / Pause">▶</button>' +
                '<button class="ir-ctrl-btn' + disabledCls + '" id="rt-map-ir-step-fwd" onclick="rtMapIRAnimStep(-1)" title="Later">▶</button>' +
                '<input type="range" id="rt-map-ir-slider" min="0" max="' + (n - 1) + '" value="' + (n - 1) + '"' +
                    disabledAttr +
                    ' oninput="rtMapIRSliderInput(parseInt(this.max) - parseInt(this.value))" class="ir-slider">' +
                '<span class="ir-label" id="rt-map-ir-label">IR t=0</span>' +
            '</div>';
        wrapper.appendChild(ctrl);
    }

    window.rtMapIRSliderInput = function (frameIdx) {
        _rtIRAnimFrame = frameIdx;
        _rtShowIROnMap(frameIdx);
        rtIRShowFrame(frameIdx);
        _rtUpdateMapIRSlider();
    };

    // Map IR play/pause
    var _rtMapIRAnimPlaying = false;
    var _rtMapIRAnimTimer = null;

    window.rtMapIRAnimToggle = function () {
        if (_rtIRLoadedCount < 2) return;
        if (_rtMapIRAnimPlaying) {
            _rtMapIRAnimPlaying = false;
            if (_rtMapIRAnimTimer) { clearTimeout(_rtMapIRAnimTimer); _rtMapIRAnimTimer = null; }
            var btn = document.getElementById('rt-map-ir-play');
            if (btn) btn.textContent = '▶';
        } else {
            _rtMapIRAnimPlaying = true;
            // Start from oldest loaded frame
            for (var i = _rtIRFrameURLs.length - 1; i >= 0; i--) {
                if (_rtIRFrameURLs[i]) { _rtIRAnimFrame = i; break; }
            }
            _rtShowIROnMap(_rtIRAnimFrame);
            rtIRShowFrame(_rtIRAnimFrame);
            _rtUpdateMapIRSlider();
            var playBtn = document.getElementById('rt-map-ir-play');
            if (playBtn) playBtn.textContent = '⏸';
            _rtMapIRAnimTick();
        }
    };

    function _rtMapIRAnimTick() {
        if (!_rtMapIRAnimPlaying) return;
        var n = _rtIRFrameURLs.length;
        // Advance to next loaded frame (going backward = older in time)
        for (var j = 0; j < n; j++) {
            _rtIRAnimFrame = (_rtIRAnimFrame - 1 + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        _rtShowIROnMap(_rtIRAnimFrame);
        rtIRShowFrame(_rtIRAnimFrame);
        _rtUpdateMapIRSlider();
        // Dwell longer on the most recent (t=0) frame
        var delay = (_rtIRAnimFrame === 0) ? 1500 : 500;
        _rtMapIRAnimTimer = setTimeout(_rtMapIRAnimTick, delay);
    }

    function _rtEnableMapIRControls() {
        ['rt-map-ir-step-back', 'rt-map-ir-play', 'rt-map-ir-step-fwd'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove('rt-ir-ctrl-disabled');
        });
        var slider = document.getElementById('rt-map-ir-slider');
        if (slider) slider.disabled = false;
    }

    function _rtCleanupMap() {
        _rtRemoveIRFromMap();
        _rtIRMapVisible = true;
        _rtIRMapBoundsSet = false;
        _rtMaxWind2km = null;
        if (_rtMapMarker && _rtMap) { _rtMap.removeLayer(_rtMapMarker); _rtMapMarker = null; }
        if (_rtMapIRAnimPlaying) {
            _rtMapIRAnimPlaying = false;
            if (_rtMapIRAnimTimer) { clearTimeout(_rtMapIRAnimTimer); _rtMapIRAnimTimer = null; }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // Azimuthal Mean Module
    // ══════════════════════════════════════════════════════════════

    var _rtLastAzJson = null;

    // Coverage slider display update
    (function () {
        var slider = document.getElementById('rt-az-coverage');
        var label = document.getElementById('rt-az-cov-val');
        if (slider && label) {
            slider.addEventListener('input', function () { label.textContent = this.value + '%'; });
        }
    })();

    window.rtFetchAzimuthalMean = function () {
        if (!_currentFileUrl) return;
        var variable = document.getElementById('rt-var').value;
        var overlay = (document.getElementById('rt-overlay') || {}).value || '';
        var covSlider = document.getElementById('rt-az-coverage');
        var coverage = covSlider ? (parseInt(covSlider.value) / 100) : 0.5;
        var resultDiv = document.getElementById('rt-az-result');
        var btn = document.getElementById('rt-az-btn');
        resultDiv.innerHTML = _rtLoadingHTML('Computing azimuthal mean…');
        btn.disabled = true; btn.textContent = '↻ Computing…';

        var url = API_BASE + RT_PREFIX + '/azimuthal_mean?file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + variable + '&coverage_min=' + coverage;
        if (overlay) url += '&overlay=' + overlay;

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        fetch(url, { signal: controller.signal })
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
            .then(function (json) { _rtLastAzJson = json; rtRenderAzimuthalMean(json); })
            .catch(function (err) {
                resultDiv.innerHTML = '<div class="explorer-status error">⚠️ ' + (err.name === 'AbortError' ? 'Request timed out (120s).' : err.message) + '</div>';
            })
            .finally(function () { clearTimeout(timeout); btn.disabled = false; btn.textContent = '↻ Azimuthal Mean'; });
    };

    function rtRenderAzimuthalMean(json) {
        var resultDiv = document.getElementById('rt-az-result');
        resultDiv.innerHTML = '<div style="position:relative;"><div id="rt-az-chart" style="width:100%;height:340px;border-radius:6px;overflow:hidden;margin-top:8px;"></div>' +
            '<button onclick="rtOpenFullscreen()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(255,255,255,0.08);border:none;color:#ccc;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;" onmouseover="this.style.background=\'rgba(255,255,255,0.2)\'" onmouseout="this.style.background=\'rgba(255,255,255,0.08)\'">⛶</button></div>' +
            '<div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Radius–height azimuthal mean · hover for values · ⛶ expand</div>';

        var azData = json.azimuthal_mean, radius_km = json.radius_km, height_km = json.height_km;
        var varInfo = json.variable, meta = json.case_meta || {};
        var covPct = Math.round((json.coverage_min || 0.5) * 100);

        // Determine active colorscale
        var cmapSel = document.getElementById('rt-cmap');
        var azColorscale = varInfo.colorscale;
        var varDefault = _rtDefaultCmapForVariable(varInfo.key || (document.getElementById('rt-var') || {}).value || '');
        if (cmapSel && cmapSel.value) { try { azColorscale = JSON.parse(cmapSel.value); } catch (e) { azColorscale = cmapSel.value; } }
        else if (varDefault) { azColorscale = varDefault; }

        var av = _rtGetVmin(), avx = _rtGetVmax();

        var heatmap = {
            z: azData, x: radius_km, y: height_km, type: 'heatmap',
            colorscale: azColorscale,
            zmin: av !== null ? av : varInfo.vmin,
            zmax: avx !== null ? avx : varInfo.vmax,
            colorbar: { title: { text: varInfo.units, font: { color: '#ccc', size: 10 } }, tickfont: { color: '#ccc', size: 9 }, thickness: 10, len: 0.85 },
            hovertemplate: '<b>' + varInfo.display_name + '</b>: %{z:.2f} ' + varInfo.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false
        };

        var overlayLabel = json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
        var title = (meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || '') +
            '<br>Azimuthal Mean: ' + varInfo.display_name + ' (≥' + covPct + '% coverage)' + overlayLabel;

        var plotBg = '#0a1628';
        var layout = {
            title: { text: title, font: { color: '#e5e7eb', size: 10 }, y: 0.97, x: 0.5, xanchor: 'center' },
            paper_bgcolor: plotBg, plot_bgcolor: plotBg,
            xaxis: { title: { text: 'Radius (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            yaxis: { title: { text: 'Height (km)', font: { color: '#aaa', size: 10 } }, tickfont: { color: '#aaa', size: 9 }, gridcolor: 'rgba(255,255,255,0.04)', zeroline: false },
            margin: { l: 48, r: 12, t: json.overlay ? 66 : 52, b: 38 },
            hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12 } },
            showlegend: false
        };

        // Overlay contours
        var azOverlayTraces = [];
        if (json.overlay && json.overlay.azimuthal_mean) {
            try {
                var ov = json.overlay, ovData = ov.azimuthal_mean;
                var flat = ovData.flat().filter(function (v) { return v !== null && !isNaN(v); });
                if (flat.length > 0) {
                    var mn = Infinity, mx = -Infinity;
                    for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
                    var interval = parseFloat(((mx - mn) / 10).toPrecision(1));
                    if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
                    var baseContour = { z: ovData, x: radius_km, y: height_km, type: 'contour', showscale: false, hoverongaps: false, contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(255,255,255,0.8)' } } };
                    if (ov.vmax > interval) azOverlayTraces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, showlegend: false }));
                    if (ov.vmin < -interval) azOverlayTraces.push(Object.assign({}, baseContour, { contours: Object.assign({}, baseContour.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, showlegend: false }));
                }
            } catch (e) { /* ignore overlay errors */ }
        }

        // Max value annotation for azimuthal mean
        var azMaxInfo = rtFindDataMax(azData, radius_km, height_km);
        var azMaxTraces = [];
        if (azMaxInfo) {
            var azMaxAnnot = rtBuildMaxAnnotation(azMaxInfo, varInfo.units, 'R', 'Z', 8);
            if (azMaxAnnot) layout.annotations = (layout.annotations || []).concat([azMaxAnnot]);
            var currentVar = (document.getElementById('rt-var') || {}).value || '';
            if (rtIsWindVariable(currentVar)) {
                var azMaxMarker = rtBuildMaxMarkerTrace(azMaxInfo, varInfo.units);
                if (azMaxMarker) azMaxTraces.push(azMaxMarker);
            }
        }

        var config = { responsive: true, displayModeBar: false, displaylogo: false };
        Plotly.newPlot('rt-az-chart', [heatmap].concat(azOverlayTraces).concat(azMaxTraces), layout, config);
    }

    // ══════════════════════════════════════════════════════════════
    // GOES IR Satellite Imagery Module
    // ══════════════════════════════════════════════════════════════

    // ── Cleanup ──────────────────────────────────────────────────
    // ── IR loading indicator on map (matches archive focus mode) ──
    function _rtShowIRLoadingIndicator() {
        if (document.getElementById('rt-ir-loading-indicator')) return;
        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;
        var div = document.createElement('div');
        div.id = 'rt-ir-loading-indicator';
        div.style.cssText = 'position:absolute;top:14px;left:14px;z-index:999;' +
            'background:rgba(10,22,40,0.88);backdrop-filter:blur(6px);' +
            'border:1px solid rgba(96,165,250,0.25);border-radius:8px;' +
            'padding:8px 16px;display:flex;align-items:center;gap:8px;';
        div.innerHTML =
            '<div style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.15);' +
            'border-top:2px solid #60a5fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
            '<span id="rt-ir-loading-text" style="font-size:11px;color:#93c5fd;font-family:\'JetBrains Mono\',monospace;">' +
            'Loading IR satellite\u2026</span>';
        wrapper.appendChild(div);
    }
    function _rtRemoveIRLoadingIndicator() {
        var el = document.getElementById('rt-ir-loading-indicator');
        if (el) el.remove();
    }
    function _rtUpdateIRLoadingText(msg) {
        var el = document.getElementById('rt-ir-loading-text');
        if (el) el.textContent = msg;
    }

    function rtIRCleanup() {
        rtIRAnimStop();
        _rtRemoveIRFromMap();
        _rtRemoveIRLoadingIndicator();
        if (_rtMapIRAnimPlaying) {
            _rtMapIRAnimPlaying = false;
            if (_rtMapIRAnimTimer) { clearTimeout(_rtMapIRAnimTimer); _rtMapIRAnimTimer = null; }
        }
        _rtIRData = null;
        _rtIRFrameURLs = [];
        _rtIRDecodedImages = [];
        _rtIRAnimFrame = 0;
        _rtIRPlotlyVisible = false;
        _rtIRAllLoaded = false;
        _rtIRLoadedCount = 0;
        _rtIRFetching = false;
        _rtIRMapBoundsSet = false;
        var irBtn = document.getElementById('rt-ir-underlay-btn');
        if (irBtn) { irBtn.disabled = true; irBtn.textContent = '🛰 IR Off'; irBtn.classList.remove('active'); }
    }

    // ── Helper: show IR on map, with retry if map not ready yet ──
    function _rtShowIROnMapWhenReady(irJson, attempt) {
        attempt = attempt || 0;
        // Bail if IR state was cleaned up (user navigated away)
        if (!_rtIRData || !irJson.frame0) {
            _rtRemoveIRLoadingIndicator();
            return;
        }
        if (_rtMap) {
            _rtShowIROnMap(0);
            _rtInjectMapIRControls();
            _rtUpdateMapIRSlider();
            rtIRShowFrame(0);
            // Replace loading spinner with frame progress
            _rtUpdateIRLoadingText('IR t=0 loaded \u2014 fetching frames\u2026');
        } else if (attempt < 20) {
            // Map not ready yet — retry in 500ms (up to 10 seconds)
            _rtUpdateIRLoadingText('Waiting for map\u2026');
            setTimeout(function () { _rtShowIROnMapWhenReady(irJson, attempt + 1); }, 500);
        } else {
            _rtRemoveIRLoadingIndicator();
        }
    }

    // ── Two-phase IR fetch ───────────────────────────────────────
    function rtFetchIR() {
        if (!_currentFileUrl || _rtIRFetching) return;
        _rtIRFetching = true;
        _rtIRAllLoaded = false;
        _rtIRLoadedCount = 0;

        var url = API_BASE + RT_PREFIX + '/ir?file_url=' + encodeURIComponent(_currentFileUrl);

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (json) {
                _rtIRData = json;
                var n = json.n_frames || 17;
                _rtIRFrameURLs = new Array(n);
                _rtIRDecodedImages = new Array(n);
                for (var i = 0; i < n; i++) { _rtIRFrameURLs[i] = null; _rtIRDecodedImages[i] = null; }

                // Store t=0 frame
                if (json.frame0) {
                    _rtIRFrameURLs[0] = json.frame0;
                    _rtIRLoadedCount = 1;
                    _rtPreDecodeIRFrame(0, json.frame0);
                }

                // Show IR on Leaflet map + inject map controls (primary IR display)
                // Handle race condition: map may not exist yet if metadata fetch
                // hasn't completed. Retry a few times with short delays.
                _rtShowIROnMapWhenReady(json);

                // Enable the Plotly underlay button
                var irBtn = document.getElementById('rt-ir-underlay-btn');
                if (irBtn && json.frame0) irBtn.disabled = false;

                // Phase 2: fetch remaining frames in parallel
                _rtFetchIRFramesParallel(1);
            })
            .catch(function (err) {
                console.warn('RT IR fetch failed:', err);
                _rtIRFetching = false;
                _rtIRData = null;
                _rtRemoveIRLoadingIndicator();
            });
    }
    window.rtFetchIR = rtFetchIR;

    function _rtFetchIRFramesParallel(startIdx) {
        if (!_rtIRData || !_currentFileUrl) { _rtIRFetching = false; return; }
        var n = _rtIRFrameURLs.length;
        var totalToFetch = n - startIdx;
        var completedCount = 0;  // tracks ALL completed requests (success, empty, or error)

        function _checkAllDone() {
            completedCount++;
            _rtIRLoadedCount = _rtCountIRLoaded();
            _rtUpdateIRLabel();
            var statusText = 'IR frames: ' + _rtIRLoadedCount + '/' + n;
            if (completedCount >= totalToFetch && _rtIRLoadedCount < n) {
                statusText = 'IR: ' + _rtIRLoadedCount + ' of ' + n + ' available';
            }
            _rtUpdateIRLoadingText(statusText);
            if (_rtIRLoadedCount >= 2) _rtEnableIRAnimControls();
            if (_rtIRLoadedCount === 2 && !_rtMapIRAnimPlaying) {
                rtMapIRAnimToggle();
            }
            if (completedCount >= totalToFetch) {
                _rtIRAllLoaded = true;
                _rtIRFetching = false;
                _rtRemoveIRLoadingIndicator();
            }
        }

        // Fire ALL requests in parallel (original working approach)
        for (var i = startIdx; i < n; i++) {
            (function (frameIdx) {
                var url = API_BASE + RT_PREFIX + '/ir_frame?file_url=' +
                    encodeURIComponent(_currentFileUrl) + '&frame_index=' + frameIdx;
                fetch(url)
                    .then(function (r) {
                        if (!r.ok) { console.warn('IR frame ' + frameIdx + ' HTTP ' + r.status); return null; }
                        return r.json();
                    })
                    .then(function (data) {
                        if (data && data.frame) {
                            _rtIRFrameURLs[data.frame_index] = data.frame;
                            _rtPreDecodeIRFrame(data.frame_index, data.frame);
                        }
                        _checkAllDone();
                    })
                    .catch(function (err) {
                        console.warn('IR frame ' + frameIdx + ' error:', err);
                        _checkAllDone();
                    });
            })(i);
        }
    }

    function _rtPreDecodeIRFrame(idx, dataUrl) {
        var img = new Image();
        img.src = dataUrl;
        if (img.decode) img.decode().catch(function () {});
        _rtIRDecodedImages[idx] = img;
    }

    function _rtCountIRLoaded() {
        var c = 0;
        for (var i = 0; i < _rtIRFrameURLs.length; i++) { if (_rtIRFrameURLs[i]) c++; }
        return c;
    }

    function _rtEnableIRAnimControls() {
        // Enable map IR overlay controls (primary IR display)
        _rtEnableMapIRControls();
    }

    // (Standalone IR panel removed — IR is shown via Leaflet map overlay only)

    // ── Display a specific IR frame ──────────────────────────────
    window.rtIRShowFrame = function (frameIdx) {
        if (!_rtIRData || frameIdx < 0 || frameIdx >= _rtIRFrameURLs.length) return;
        _rtIRAnimFrame = frameIdx;

        // Update Leaflet map IR overlay (primary display)
        if (_rtMap && _rtIRMapVisible) _rtShowIROnMap(frameIdx);
        _rtUpdateMapIRSlider();

        // If Plotly underlay is active, update it to current frame
        if (_rtIRPlotlyVisible) _rtApplyIRUnderlay();
    };

    function _rtUpdateIRLabel() {
        // Update the map overlay IR label (only label now — standalone panel removed)
        var label = document.getElementById('rt-map-ir-label');
        if (!label || !_rtIRData) return;
        var lagMin = _rtIRData.lag_minutes ? _rtIRData.lag_minutes[_rtIRAnimFrame] : 0;
        var dtStr = _rtIRData.frame_datetimes ? _rtIRData.frame_datetimes[_rtIRAnimFrame] : '';
        var lagStr = lagMin === 0 ? 't=0' : 't\u2212' + (lagMin >= 60 ? (lagMin / 60).toFixed(1) + 'h' : lagMin + 'min');
        if (_rtIRAllLoaded) {
            label.textContent = 'IR ' + lagStr + (dtStr ? ' | ' + dtStr : '');
        } else {
            label.textContent = 'IR ' + lagStr + ' | Loading ' + _rtIRLoadedCount + '/' + _rtIRFrameURLs.length + '…';
        }
    }

    // ── Animation ────────────────────────────────────────────────
    window.rtIRAnimToggle = function () {
        if (_rtIRLoadedCount < 2) return;
        if (_rtIRAnimPlaying) { rtIRAnimStop(); }
        else {
            _rtIRAnimPlaying = true;
            // Update map play button
            var mapBtn = document.getElementById('rt-map-ir-play');
            if (mapBtn) mapBtn.textContent = '⏸';
            // Start from earliest frame (highest index)
            for (var i = _rtIRFrameURLs.length - 1; i >= 0; i--) {
                if (_rtIRFrameURLs[i]) { _rtIRAnimFrame = i; break; }
            }
            rtIRShowFrame(_rtIRAnimFrame);
            _rtIRAnimTick();
        }
    };

    function _rtIRAnimTick() {
        if (!_rtIRAnimPlaying) return;
        // Step towards t=0 (decreasing index), skip null frames
        var n = _rtIRFrameURLs.length;
        var start = _rtIRAnimFrame;
        for (var i = 0; i < n; i++) {
            _rtIRAnimFrame = (_rtIRAnimFrame - 1 + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        rtIRShowFrame(_rtIRAnimFrame);

        if (_rtIRAnimFrame === 0) {
            // Pause at t=0, then loop back to earliest
            _rtIRAnimTimer = setTimeout(function () {
                for (var i = _rtIRFrameURLs.length - 1; i >= 0; i--) {
                    if (_rtIRFrameURLs[i]) { _rtIRAnimFrame = i; break; }
                }
                rtIRShowFrame(_rtIRAnimFrame);
                _rtIRAnimTimer = setTimeout(_rtIRAnimTick, 500);
            }, 1500);
        } else {
            _rtIRAnimTimer = setTimeout(_rtIRAnimTick, 500);
        }
    }

    function rtIRAnimStop() {
        _rtIRAnimPlaying = false;
        if (_rtIRAnimTimer) { clearTimeout(_rtIRAnimTimer); _rtIRAnimTimer = null; }
        var mapBtn = document.getElementById('rt-map-ir-play');
        if (mapBtn) mapBtn.textContent = '▶';
    }

    window.rtIRAnimStep = function (dir) {
        if (_rtIRLoadedCount < 2) return;
        rtIRAnimStop();
        var n = _rtIRFrameURLs.length;
        for (var i = 0; i < n; i++) {
            _rtIRAnimFrame = (_rtIRAnimFrame + dir + n) % n;
            if (_rtIRFrameURLs[_rtIRAnimFrame]) break;
        }
        rtIRShowFrame(_rtIRAnimFrame);
    };

    // ── Plotly IR Underlay Toggle ────────────────────────────────
    window.rtToggleIRUnderlay = function () {
        _rtIRPlotlyVisible = !_rtIRPlotlyVisible;
        var btn = document.getElementById('rt-ir-underlay-btn');
        if (btn) {
            btn.classList.toggle('active', _rtIRPlotlyVisible);
            btn.textContent = _rtIRPlotlyVisible ? '🛰 IR On' : '🛰 IR Off';
        }
        if (_rtIRPlotlyVisible) {
            _rtApplyIRUnderlay();
        } else {
            _rtRemoveIRUnderlay();
        }
    };

    function _rtBuildIRPlotlyImage() {
        if (!_rtIRData || !_rtIRFrameURLs.length) return null;
        var url = _rtIRFrameURLs[_rtIRAnimFrame] || _rtIRFrameURLs[0];
        if (!url) return null;

        var bk = _rtIRData.bounds_km;
        if (!bk) return null;

        return {
            source: url,
            xref: 'x', yref: 'y',
            x: bk.x_min_km,
            y: bk.y_max_km,
            sizex: bk.x_max_km - bk.x_min_km,
            sizey: bk.y_max_km - bk.y_min_km,
            sizing: 'stretch',
            opacity: 0.35,
            layer: 'below',
            _rtIRUnderlay: true,
        };
    }

    function _rtApplyIRUnderlay() {
        var irImg = _rtBuildIRPlotlyImage();
        if (!irImg) return;
        ['rt-plotly-chart', 'rt-fullscreen-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || !el.layout) return;
            var images = (el.layout.images || []).filter(function (img) { return !img._rtIRUnderlay; });
            images.push(irImg);
            Plotly.relayout(el, { images: images });
        });
    }

    function _rtRemoveIRUnderlay() {
        ['rt-plotly-chart', 'rt-fullscreen-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el || !el.layout) return;
            var images = (el.layout.images || []).filter(function (img) { return !img._rtIRUnderlay; });
            Plotly.relayout(el, { images: images });
        });
    }

    // ══════════════════════════════════════════════════════════════
    // Dropsonde Observations Module
    // ══════════════════════════════════════════════════════════════

    var _rtSondeData = null;           // cached API response
    var _rtSondeVisible = false;       // toggle state
    var _rtSondeMode = 'off';         // 'off' | 'on' | 'only' (three-state cycle)
    var _rtSondeMapLayers = [];        // Leaflet layers for map view
    var _rtSondeTraceCount = 0;        // number of Plotly traces added to plan-view
    var _rtSondeFetching = false;      // prevent duplicate fetches

    // ── Sonde colour palette (by index, for distinguishing multiple sondes) ──
    var _SONDE_COLORS = [
        '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9',
        '#f0abfc', '#e879f9', '#d946ef', '#c026d3', '#a855f7',
        '#fb7185', '#f43f5e', '#e11d48', '#fbbf24', '#f59e0b',
        '#34d399', '#10b981', '#06b6d4', '#22d3ee', '#67e8f9'
    ];

    function _sondeColor(idx) {
        return _SONDE_COLORS[idx % _SONDE_COLORS.length];
    }

    // ── Wind speed → colour (matching TDR convention) ────────────
    function _sondeWindColor(wspd) {
        if (wspd == null || isNaN(wspd)) return '#6b7280';
        if (wspd < 17.5) return '#60a5fa';
        if (wspd < 33.0) return '#34d399';
        if (wspd < 43.0) return '#fbbf24';
        if (wspd < 49.5) return '#fb923c';
        if (wspd < 58.0) return '#f87171';
        if (wspd < 70.5) return '#ef4444';
        return '#dc2626';
    }

    // ── Cleanup on file switch ───────────────────────────────────
    var _rt3DSondeTraceStart = -1; // starting trace index in 3D chart for sonde traces

    function _rtSondeCleanup() {
        // Restore TDR visibility if it was hidden
        if (_rtSondeMode === 'only') _rtSetTDRVisible(true);
        _rtSondeData = null;
        _rtSondeVisible = false;
        _rtSondeMode = 'off';
        _rtSondeFetching = false;
        _rtSondeTraceCount = 0;
        _rt3DSondeTraceStart = -1;
        _rtRemoveSondesFromMap();
        // Close Skew-T panel if open
        if (typeof rtCloseSkewT === 'function') rtCloseSkewT();
        // Hide and reset sonde dropdown
        var sel = document.getElementById('rt-sonde-select');
        if (sel) { sel.style.display = 'none'; sel.disabled = true; sel.innerHTML = '<option value="">\uD83E\uDE82 Select Sonde\u2026</option>'; }
        var btn = document.getElementById('rt-sonde-btn');
        if (btn) {
            btn.disabled = true;
            btn.classList.remove('active');
            btn.classList.remove('sonde-only');
            btn.textContent = '\uD83E\uDE82 Sondes Off';
        }
    }

    // ── Show/hide TDR heatmap + contour traces on plan-view ─────
    function _rtSetTDRVisible(vis) {
        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data) return;
        // Trace 0 is the heatmap; any non-sonde traces after that are contours/max markers
        var tdrIndices = [];
        for (var i = 0; i < plotDiv.data.length; i++) {
            if (!plotDiv.data[i]._rtSonde) tdrIndices.push(i);
        }
        if (tdrIndices.length > 0) {
            Plotly.restyle(plotDiv, { visible: vis }, tdrIndices);
        }
    }

    // ── Toggle button handler (3-state cycle: Off → On → Only → Off) ──
    function _rtUpdateSondeBtn() {
        var btn = document.getElementById('rt-sonde-btn');
        if (!btn) return;
        var nStr = _rtSondeData ? ' (' + _rtSondeData.n_sondes + ')' : '';
        btn.classList.remove('active', 'sonde-only');
        if (_rtSondeMode === 'on') {
            btn.classList.add('active');
            btn.textContent = '\uD83E\uDE82 Sondes On' + nStr;
        } else if (_rtSondeMode === 'only') {
            btn.classList.add('active', 'sonde-only');
            btn.textContent = '\uD83E\uDE82 Sondes Only' + nStr;
        } else {
            btn.textContent = '\uD83E\uDE82 Sondes Off';
        }
    }

    window.rtToggleDropsondes = function () {
        if (_rtSondeFetching) return;

        if (!_rtSondeData && _rtSondeMode === 'off') {
            // First activation: fetch data
            _rtSondeFetching = true;
            var btn = document.getElementById('rt-sonde-btn');
            if (btn) btn.textContent = '\uD83E\uDE82 Loading\u2026';

            fetch(API_BASE + RT_PREFIX + '/dropsondes?file_url=' + encodeURIComponent(_currentFileUrl))
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(function (json) {
                    _rtSondeData = json;
                    _rtSondeFetching = false;

                    if (json.n_sondes === 0) {
                        rtToast('No dropsondes found within \u00b145 min of analysis time' +
                            (json.message ? ' (' + json.message + ')' : ''), 'warn', 6000);
                        if (btn) btn.textContent = '\uD83E\uDE82 No Sondes';
                        return;
                    }

                    _rtSondeVisible = true;
                    _rtSondeMode = 'on';
                    _rtUpdateSondeBtn();
                    rtToast(json.n_sondes + ' dropsonde' + (json.n_sondes > 1 ? 's' : '') + ' loaded \u2014 click again for Sondes Only', 'info', 5000);

                    _rtPopulateSondeDropdowns();
                    _rtRenderSondesOnMap();
                    _rtRenderSondesOnPlot();
                })
                .catch(function (err) {
                    _rtSondeFetching = false;
                    if (btn) btn.textContent = '\uD83E\uDE82 Sondes Off';
                    rtToast('Dropsonde fetch failed: ' + err.message, 'error');
                });
            return;
        }

        // Three-state cycle: off → on → only → off
        if (_rtSondeMode === 'off') {
            // Off → On (overlay)
            _rtSondeMode = 'on';
            _rtSondeVisible = true;
            _rtSetTDRVisible(true);
            _rtRenderSondesOnMap();
            _rtRenderSondesOnPlot();
        } else if (_rtSondeMode === 'on') {
            // On → Only (hide TDR, boost sondes)
            _rtSondeMode = 'only';
            _rtSondeVisible = true;
            _rtSetTDRVisible(false);
            // Re-render sondes with bolder styling
            _rtRemoveSondesFromPlot();
            _rtRenderSondesOnPlot();
        } else {
            // Only → Off
            _rtSondeMode = 'off';
            _rtSondeVisible = false;
            _rtSetTDRVisible(true);
            _rtRemoveSondesFromMap();
            _rtRemoveSondesFromPlot();
            // Close Skew-T panel
            if (typeof rtCloseSkewT === 'function') rtCloseSkewT();
        }
        _rtUpdateSondeBtn();
    };

    // ── Leaflet Map: Render dropsonde trajectories ───────────────
    function _rtRenderSondesOnMap() {
        _rtRemoveSondesFromMap();
        if (!_rtMap || !_rtSondeData || !_rtSondeData.dropsondes.length) return;

        _rtSondeData.dropsondes.forEach(function (sonde, idx) {
            var p = sonde.profile;
            if (!p.lat || p.lat.length < 2) return;

            var color = _sondeColor(idx);

            // Build polyline coordinates (filter nulls)
            var coords = [];
            for (var i = 0; i < p.lat.length; i++) {
                if (p.lat[i] != null && p.lon[i] != null) {
                    coords.push([p.lat[i], p.lon[i]]);
                }
            }
            if (coords.length < 2) return;

            // Trajectory polyline
            var polyline = L.polyline(coords, {
                color: color,
                weight: 2.5,
                opacity: 0.8,
                dashArray: null
            }).addTo(_rtMap);
            _rtSondeMapLayers.push(polyline);

            // Launch marker (circle — top of drop)
            var launchMarker = L.circleMarker(coords[0], {
                radius: 5,
                fillColor: color,
                fillOpacity: 0.3,
                color: color,
                weight: 2,
                opacity: 1
            }).addTo(_rtMap);
            _rtSondeMapLayers.push(launchMarker);

            // Surface marker (filled circle — bottom of drop)
            var sfcMarker = L.circleMarker(coords[coords.length - 1], {
                radius: 6,
                fillColor: color,
                fillOpacity: 0.9,
                color: '#fff',
                weight: 1.5,
                opacity: 1
            }).addTo(_rtMap);
            _rtSondeMapLayers.push(sfcMarker);

            // Compute max wind for popup
            var maxWspd = -Infinity;
            for (var w = 0; w < p.wspd.length; w++) {
                if (p.wspd[w] != null && p.wspd[w] > maxWspd) maxWspd = p.wspd[w];
            }
            var maxWspdStr = isFinite(maxWspd) ? maxWspd.toFixed(1) + ' m/s' : 'N/A';
            var windColor = isFinite(maxWspd) ? _sondeWindColor(maxWspd) : '#aaa';

            // Time offset string
            var tOffStr = sonde.time_offset_min != null ?
                (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min' : '';

            // Alt drop string
            var launchAltStr = sonde.launch.alt_m != null ? (sonde.launch.alt_m / 1000).toFixed(1) + ' km' : '?';
            var sfcAltStr = sonde.surface.alt_m != null ? (sonde.surface.alt_m / 1000).toFixed(1) + ' km' : '?';

            // Horizontal drift
            var driftKm = Math.sqrt(
                Math.pow(sonde.surface.x_km - sonde.launch.x_km, 2) +
                Math.pow(sonde.surface.y_km - sonde.launch.y_km, 2)
            ).toFixed(1);

            var popupHtml =
                '<div class="sonde-popup">' +
                '<div class="sonde-title">\uD83E\uDE82 Dropsonde ' + (sonde.sonde_id || '#' + (idx + 1)) + '</div>' +
                '<div class="sonde-meta">' + sonde.launch_time + ' (' + tOffStr + ' from TDR)</div>' +
                '<div class="sonde-meta">' + (sonde.platform || '') + ' / ' + (sonde.flight || '') + '</div>' +
                '<div class="sonde-stats">' +
                'Max wind: <strong style="color:' + windColor + ';">' + maxWspdStr + '</strong><br>' +
                'Alt: ' + launchAltStr + ' \u2192 ' + sfcAltStr +
                ' | Drift: <strong>' + driftKm + ' km</strong>' +
                (sonde.hit_surface ? ' | Hit sfc' : '') +
                '</div>' +
                (sonde.comments ? '<div class="sonde-comment">' + sonde.comments + '</div>' : '') +
                '</div>';

            // Bind popup to all three layers
            polyline.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
            launchMarker.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
            sfcMarker.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
        });
    }

    function _rtRemoveSondesFromMap() {
        _rtSondeMapLayers.forEach(function (layer) {
            if (_rtMap) _rtMap.removeLayer(layer);
        });
        _rtSondeMapLayers = [];
    }

    // ── Plan-View Plotly: Render dropsonde at current height ─────
    function _rtRenderSondesOnPlot() {
        _rtRemoveSondesFromPlot();
        if (!_rtSondeVisible || !_rtSondeData || !_rtSondeData.dropsondes.length) return;

        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data) return;

        var currentLevel = parseFloat((document.getElementById('rt-level') || {}).value || '2');
        var traces = [];
        var isBold = (_rtSondeMode === 'only');  // bolder styling when TDR is hidden

        _rtSondeData.dropsondes.forEach(function (sonde, idx) {
            var p = sonde.profile;
            if (!p.x_km || p.x_km.length < 2) return;

            var color = _sondeColor(idx);

            // Pre-compute column-max wind, min SLP, and launch alt for all hover labels
            var colMaxWspd = -Infinity, colMinPres = Infinity;
            for (var w = 0; w < p.wspd.length; w++) {
                if (p.wspd[w] != null && p.wspd[w] > colMaxWspd) colMaxWspd = p.wspd[w];
            }
            for (var pr = 0; pr < p.pres.length; pr++) {
                if (p.pres[pr] != null && p.pres[pr] < colMinPres) colMinPres = p.pres[pr];
            }
            var maxWspdStr = isFinite(colMaxWspd) ? colMaxWspd.toFixed(1) : '?';
            var maxWindColor = isFinite(colMaxWspd) ? _sondeWindColor(colMaxWspd) : '#aaa';

            // Time offset string
            var tOffStr = sonde.time_offset_min != null ?
                (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min' : '';

            // Horizontal drift
            var driftKm = Math.sqrt(
                Math.pow(sonde.surface.x_km - sonde.launch.x_km, 2) +
                Math.pow(sonde.surface.y_km - sonde.launch.y_km, 2)
            ).toFixed(1);

            // Shared sonde label for all markers
            var sondeLabel = sonde.sonde_id || '#' + (idx + 1);

            // Full trajectory line (faded) — show basic info on hover too
            var trajX = [], trajY = [], trajHover = [];
            for (var i = 0; i < p.x_km.length; i++) {
                if (p.x_km[i] != null && p.y_km[i] != null) {
                    trajX.push(p.x_km[i]);
                    trajY.push(p.y_km[i]);
                    var hParts = ['<b>' + sondeLabel + '</b>'];
                    if (p.alt_km[i] != null) hParts.push('Alt: ' + p.alt_km[i].toFixed(1) + ' km');
                    if (p.wspd[i] != null) hParts.push('Wind: ' + p.wspd[i].toFixed(1) + ' m/s');
                    if (p.temp[i] != null) hParts.push('T: ' + p.temp[i].toFixed(1) + '\u00b0C');
                    trajHover.push(hParts.join('<br>'));
                }
            }
            traces.push({
                x: trajX, y: trajY, type: 'scatter', mode: isBold ? 'lines+markers' : 'lines',
                line: { color: color, width: isBold ? 3 : 1.5, dash: isBold ? 'solid' : 'dot' },
                marker: isBold ? { size: 3, color: color, opacity: 0.6 } : undefined,
                opacity: isBold ? 0.85 : 0.4,
                hoverinfo: 'text',
                hovertext: trajHover,
                showlegend: false,
                _rtSonde: true
            });

            // Launch marker (top)
            var launchAlt = sonde.launch.alt_m != null ? (sonde.launch.alt_m / 1000).toFixed(1) + ' km' : '?';
            traces.push({
                x: [sonde.launch.x_km], y: [sonde.launch.y_km],
                type: 'scatter', mode: 'markers',
                marker: { symbol: 'circle-open', size: isBold ? 10 : 7, color: color, line: { width: isBold ? 2.5 : 1.5, color: color } },
                hoverinfo: 'text',
                hovertext: ['<b>\uD83E\uDE82 ' + sondeLabel + ' \u2014 LAUNCH</b>' +
                    '<br>Alt: ' + launchAlt +
                    '<br>Time: ' + sonde.launch_time + (tOffStr ? ' (' + tOffStr + ')' : '') +
                    '<br>Max Wind: ' + maxWspdStr + ' m/s  |  Drift: ' + driftKm + ' km' +
                    (sonde.platform ? '<br>' + sonde.platform + ' / ' + sonde.flight : '') +
                    (sonde.comments ? '<br>' + sonde.comments : '') +
                    '<br><i>\u25B6 Click for Skew-T</i>'],
                showlegend: false,
                _rtSonde: true,
                _rtSondeIdx: idx,
                _rtSondeClickable: true
            });

            // Surface marker (bottom)
            var sfcAlt = sonde.surface.alt_m != null ? (sonde.surface.alt_m / 1000).toFixed(1) + ' km' : 'sfc';
            // Get surface wind and temp (last valid values)
            var sfcWspd = null, sfcTemp = null;
            for (var si = p.wspd.length - 1; si >= 0; si--) {
                if (sfcWspd == null && p.wspd[si] != null) sfcWspd = p.wspd[si];
                if (sfcTemp == null && p.temp[si] != null) sfcTemp = p.temp[si];
                if (sfcWspd != null && sfcTemp != null) break;
            }
            traces.push({
                x: [sonde.surface.x_km], y: [sonde.surface.y_km],
                type: 'scatter', mode: 'markers',
                marker: { symbol: 'diamond', size: isBold ? 11 : 8, color: color },
                hoverinfo: 'text',
                hovertext: ['<b>\uD83E\uDE82 ' + sondeLabel + ' \u2014 SURFACE</b>' +
                    '<br>Alt: ' + sfcAlt +
                    (sfcWspd != null ? '<br>Sfc Wind: ' + sfcWspd.toFixed(1) + ' m/s' : '') +
                    (sfcTemp != null ? '<br>Sfc Temp: ' + sfcTemp.toFixed(1) + ' \u00b0C' : '') +
                    '<br>Max Wind: ' + maxWspdStr + ' m/s  |  Drift: ' + driftKm + ' km' +
                    (sonde.hit_surface ? '<br>Hit Surface' : '') +
                    (sonde.comments ? '<br>' + sonde.comments : '') +
                    '<br><i>\u25B6 Click for Skew-T</i>'],
                showlegend: false,
                _rtSonde: true,
                _rtSondeIdx: idx,
                _rtSondeClickable: true
            });

            // Interpolated position at current height level
            var interpPt = _rtInterpolateSondeAtLevel(p, currentLevel);
            if (interpPt) {
                // Get wind speed for color
                var wspdColor = interpPt.wspd != null ? _sondeWindColor(interpPt.wspd) : color;
                var wspdText = interpPt.wspd != null ? interpPt.wspd.toFixed(1) + ' m/s' : '';
                var hoverContent = '<b>\uD83E\uDE82 ' + sondeLabel + ' @ ' + currentLevel.toFixed(1) + ' km</b>' +
                    (wspdText ? '<br>Wind: ' + wspdText : '') +
                    (interpPt.temp != null ? '<br>Temp: ' + interpPt.temp.toFixed(1) + ' \u00b0C' : '') +
                    '<br>Max Wind: ' + maxWspdStr + ' m/s' +
                    (tOffStr ? '<br>Offset: ' + tOffStr : '') +
                    (sonde.comments ? '<br>' + sonde.comments : '') +
                    '<br><i>\u25B6 Click for Skew-T</i>';
                // Invisible larger hit-target underneath for easier clicking
                traces.push({
                    x: [interpPt.x], y: [interpPt.y],
                    type: 'scatter', mode: 'markers',
                    marker: { symbol: 'circle', size: isBold ? 30 : 24, color: 'rgba(0,0,0,0)', line: { width: 0 } },
                    hoverinfo: 'text',
                    hovertext: [hoverContent],
                    showlegend: false,
                    _rtSonde: true,
                    _rtSondeIdx: idx,
                    _rtSondeClickable: true
                });
                // Visible marker on top
                traces.push({
                    x: [interpPt.x], y: [interpPt.y],
                    type: 'scatter', mode: 'markers',
                    marker: {
                        symbol: 'circle', size: isBold ? 16 : 13, color: wspdColor,
                        line: { color: '#fff', width: isBold ? 3 : 2 }
                    },
                    hoverinfo: 'text',
                    hovertext: [hoverContent],
                    showlegend: false,
                    _rtSonde: true,
                    _rtSondeIdx: idx,
                    _rtSondeClickable: true
                });
            }
        });

        if (traces.length > 0) {
            Plotly.addTraces(plotDiv, traces);
            _rtSondeTraceCount = traces.length;

            // Attach click handler for sonde markers (only once)
            if (!plotDiv._rtSondeClickBound) {
                plotDiv.on('plotly_click', function (eventData) {
                    if (!eventData || !eventData.points || !eventData.points.length) return;
                    var pt = eventData.points[0];
                    if (pt.data && pt.data._rtSondeClickable && pt.data._rtSondeIdx != null) {
                        _rtShowSondeSkewT(pt.data._rtSondeIdx);
                    }
                });
                // Change cursor to pointer when hovering over clickable sonde markers
                plotDiv.on('plotly_hover', function (eventData) {
                    if (!eventData || !eventData.points || !eventData.points.length) return;
                    var pt = eventData.points[0];
                    if (pt.data && pt.data._rtSondeClickable) {
                        plotDiv.style.cursor = 'pointer';
                    }
                });
                plotDiv.on('plotly_unhover', function () {
                    plotDiv.style.cursor = '';
                });
                plotDiv._rtSondeClickBound = true;
            }
        }
    }

    function _rtRemoveSondesFromPlot() {
        if (_rtSondeTraceCount <= 0) return;
        var plotDiv = document.getElementById('rt-plotly-chart');
        if (!plotDiv || !plotDiv.data) return;

        // Find indices of sonde traces (from end)
        var indices = [];
        for (var i = plotDiv.data.length - 1; i >= 0; i--) {
            if (plotDiv.data[i]._rtSonde) indices.push(i);
        }
        if (indices.length > 0) {
            try { Plotly.deleteTraces(plotDiv, indices); } catch (e) { /* ignore */ }
        }
        _rtSondeTraceCount = 0;
    }

    // ── Interpolate sonde position at a given altitude ───────────
    function _rtInterpolateSondeAtLevel(profile, levelKm) {
        if (!profile.alt_km || profile.alt_km.length < 2) return null;

        // Find the two bracketing points
        var bestIdx = -1;
        var bestDist = Infinity;
        for (var i = 0; i < profile.alt_km.length; i++) {
            if (profile.alt_km[i] == null || profile.x_km[i] == null) continue;
            var dist = Math.abs(profile.alt_km[i] - levelKm);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        // Only return if within 0.5 km of the requested level
        if (bestIdx < 0 || bestDist > 0.5) return null;

        return {
            x: profile.x_km[bestIdx],
            y: profile.y_km[bestIdx],
            alt: profile.alt_km[bestIdx],
            wspd: profile.wspd[bestIdx],
            temp: profile.temp[bestIdx]
        };
    }

    // ── Update sondes when height level changes ──────────────────
    function _rtUpdateSondeLevel() {
        if (!_rtSondeVisible || !_rtSondeData) return;
        _rtRenderSondesOnPlot();
    }

    // ── Skew-T from dropsonde click ──────────────────────────────
    function _rtShowSondeSkewT(sondeIdx) {
        if (!_rtSondeData || sondeIdx < 0 || sondeIdx >= _rtSondeData.dropsondes.length) return;
        var sonde = _rtSondeData.dropsondes[sondeIdx];
        var p = sonde.profile;

        if (!p.pres || !p.temp || p.pres.length < 5) {
            rtToast('Insufficient data for Skew-T', 'warn');
            return;
        }

        // Build profiles object expected by renderSkewT():
        //   { plev: hPa[], t: Kelvin[], q: kg/kg[], u: m/s[], v: m/s[] }
        // Dropsonde has: pres (hPa), temp (°C), dewpoint (°C) or rh (%), uwnd, vwnd
        var plev = [], tK = [], qArr = [], uArr = [], vArr = [];
        var eps = 0.622;

        for (var i = 0; i < p.pres.length; i++) {
            // Need at least pressure and temperature
            if (p.pres[i] == null || p.temp[i] == null) continue;
            var pHpa = p.pres[i];
            var tCel = p.temp[i];
            if (pHpa < 50 || pHpa > 1100) continue;

            plev.push(pHpa);
            tK.push(tCel + 273.15);

            // Compute specific humidity q from dewpoint or RH
            var q = null;
            if (p.dewpoint && p.dewpoint[i] != null) {
                // From dewpoint: e = 6.112 * exp(17.67 * Td / (Td + 243.5))
                var td = p.dewpoint[i];
                var e = 6.112 * Math.exp(17.67 * td / (td + 243.5));
                if (e < pHpa) q = eps * e / (pHpa - e);
            } else if (p.rh && p.rh[i] != null) {
                // From RH: es = 6.112 * exp(17.67 * T / (T + 243.5)), e = RH/100 * es
                var es = 6.112 * Math.exp(17.67 * tCel / (tCel + 243.5));
                var e2 = (p.rh[i] / 100.0) * es;
                if (e2 < pHpa) q = eps * e2 / (pHpa - e2);
            }
            qArr.push(q);

            uArr.push(p.uwnd ? p.uwnd[i] : null);
            vArr.push(p.vwnd ? p.vwnd[i] : null);
        }

        if (plev.length < 5) {
            rtToast('Insufficient valid data for Skew-T (' + plev.length + ' levels)', 'warn');
            return;
        }

        var profiles = { plev: plev, t: tK, q: qArr, u: uArr, v: vArr };

        // Set title
        var titleEl = document.getElementById('rt-skewt-title');
        if (titleEl) {
            var tOff = sonde.time_offset_min != null ?
                (sonde.time_offset_min >= 0 ? '+' : '') + sonde.time_offset_min.toFixed(0) + ' min' : '';
            titleEl.textContent = '\uD83E\uDE82 Sonde ' + (sonde.sonde_id || '#' + (sondeIdx + 1)) +
                ' \u2014 ' + sonde.launch_time +
                (tOff ? ' (' + tOff + ')' : '') +
                (sonde.comments ? ' \u2014 ' + sonde.comments : '');
        }

        // Show panel
        var panel = document.getElementById('rt-sonde-skewt-panel');
        if (panel) panel.style.display = 'block';

        // Render Skew-T using the existing global renderSkewT function
        if (typeof renderSkewT === 'function') {
            renderSkewT(profiles, 'rt-sonde-skewt');
        }

        // Dynamic vertical scaling: adjust y-axis to fit the sonde's data range
        _rtAdjustSkewTYAxis(plev);

        // Render info panel (custom for RT since _renderSkewTInfo targets a hardcoded div)
        _rtRenderSondeSkewTInfo(profiles, sonde);

        // Sync dropdown selections
        var sel = document.getElementById('rt-sonde-select');
        if (sel) sel.value = String(sondeIdx);
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) sel2.value = String(sondeIdx);

        // Scroll into view
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ── Render dropsonde Skew-T info panel ───────────────────────
    function _rtRenderSondeSkewTInfo(profiles, sonde) {
        var el = document.getElementById('rt-sonde-skewt-info');
        if (!el) return;

        var derived = profiles._derived || {};
        var tC = profiles._tC || [];
        var tdC = profiles._tdC || [];
        var plev = profiles.plev;

        var html = '<div style="font-family:DM Sans,monospace;">';

        // Sonde metadata
        html += '<div style="color:#c4b5fd;font-weight:700;margin-bottom:6px;">' +
            '\uD83E\uDE82 ' + (sonde.sonde_id || 'Unknown') + '</div>';
        html += '<div style="margin-bottom:8px;font-size:10px;color:#8899aa;">' +
            (sonde.platform || '') + ' / ' + (sonde.flight || '') + '<br>' +
            sonde.launch_time + '<br>' +
            (sonde.comments ? '<span style="color:#fbbf24;">' + sonde.comments + '</span>' : '') +
            '</div>';

        // Derived thermodynamic parameters
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 8px;margin-bottom:10px;font-size:10px;">';

        function _val(v, unit, dp) {
            return v != null && isFinite(v) ? v.toFixed(dp || 0) + ' ' + (unit || '') : '\u2014';
        }

        html += '<div>CAPE</div><div style="color:#ef4444;font-weight:700;">' + _val(derived.cape, 'J/kg') + '</div>';
        html += '<div>CIN</div><div style="color:#60a5fa;">' + _val(derived.cin, 'J/kg') + '</div>';
        html += '<div>PWAT</div><div style="color:#06b6d4;">' + _val(derived.pwat, 'mm', 1) + '</div>';
        html += '<div>LCL</div><div>' + _val(derived.lcl_p, 'hPa') + '</div>';
        html += '<div>LFC</div><div>' + _val(derived.lfc_p, 'hPa') + '</div>';
        html += '<div>EL</div><div>' + _val(derived.el_p, 'hPa') + '</div>';
        html += '<div>0\u00b0C</div><div>' + _val(derived.freezing_p, 'hPa') + '</div>';

        // Surface conditions
        if (plev.length > 0) {
            // Find surface (highest pressure)
            var sfcIdx = 0;
            for (var si = 1; si < plev.length; si++) {
                if (plev[si] > plev[sfcIdx]) sfcIdx = si;
            }
            html += '<div>Sfc P</div><div>' + _val(plev[sfcIdx], 'hPa') + '</div>';
            if (tC[sfcIdx] != null) html += '<div>Sfc T</div><div>' + _val(tC[sfcIdx], '\u00b0C', 1) + '</div>';
            if (tdC[sfcIdx] != null) html += '<div>Sfc Td</div><div>' + _val(tdC[sfcIdx], '\u00b0C', 1) + '</div>';
        }
        html += '</div>';

        // Mini vertical profile table
        html += '<div style="font-size:9px;color:#667;margin-top:4px;">PROFILE (' + plev.length + ' levels)</div>';
        html += '<table style="width:100%;font-size:9px;border-collapse:collapse;margin-top:2px;">';
        html += '<tr style="color:#667;border-bottom:1px solid rgba(255,255,255,0.06);">' +
            '<th style="text-align:left;padding:1px 2px;">P</th>' +
            '<th style="text-align:right;padding:1px 2px;">T</th>' +
            '<th style="text-align:right;padding:1px 2px;">Td</th>' +
            '<th style="text-align:right;padding:1px 2px;">Ws</th></tr>';

        // Show every ~25 hPa for a compact table
        var lastP = 9999;
        for (var ri = 0; ri < plev.length; ri++) {
            if (Math.abs(plev[ri] - lastP) < 25 && ri > 0 && ri < plev.length - 1) continue;
            lastP = plev[ri];
            var wspd = null;
            if (profiles.u && profiles.v && profiles.u[ri] != null && profiles.v[ri] != null) {
                wspd = Math.sqrt(profiles.u[ri] * profiles.u[ri] + profiles.v[ri] * profiles.v[ri]);
            }
            html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.03);">' +
                '<td style="padding:1px 2px;">' + (plev[ri] != null ? plev[ri].toFixed(0) : '') + '</td>' +
                '<td style="text-align:right;padding:1px 2px;color:#ef4444;">' + (tC[ri] != null ? tC[ri].toFixed(1) : '') + '</td>' +
                '<td style="text-align:right;padding:1px 2px;color:#22c55e;">' + (tdC[ri] != null ? tdC[ri].toFixed(1) : '') + '</td>' +
                '<td style="text-align:right;padding:1px 2px;">' + (wspd != null ? wspd.toFixed(1) : '') + '</td></tr>';
        }
        html += '</table>';
        html += '</div>';
        el.innerHTML = html;
    }

    // ── Dynamic Skew-T vertical scaling ────────────────────────
    function _rtAdjustSkewTYAxis(plev) {
        var skDiv = document.getElementById('rt-sonde-skewt');
        if (!skDiv || !skDiv.layout) return;

        // Find min pressure (highest altitude) in the sonde data
        var minP = Infinity;
        for (var i = 0; i < plev.length; i++) {
            if (plev[i] != null && plev[i] < minP) minP = plev[i];
        }

        // Add 15% headroom above the highest data point
        var topP = Math.max(minP * 0.85, 80);

        // Choose sensible top boundary and tick values based on sonde depth
        var yTop, tickVals;
        if (topP >= 550) {
            // Shallow sonde (P-3, ~700+ hPa range): zoom in
            yTop = 550;
            tickVals = [1000, 950, 900, 850, 800, 750, 700, 650, 600];
        } else if (topP >= 350) {
            // Mid-depth sonde (~400-550 hPa top)
            yTop = topP < 400 ? 350 : Math.round(topP / 50) * 50;
            tickVals = [1000, 900, 850, 800, 700, 600, 500, 400];
            if (yTop <= 350) tickVals.push(350);
        } else {
            // Deep sonde (G-IV or full troposphere): keep full range
            yTop = 100;
            tickVals = [1000, 850, 700, 500, 400, 300, 200, 150, 100];
        }

        Plotly.relayout(skDiv, {
            'yaxis.range': [Math.log10(1050), Math.log10(yTop)],
            'yaxis.tickvals': tickVals
        });
    }

    // ── Close Skew-T panel ───────────────────────────────────────
    window.rtCloseSkewT = function () {
        var panel = document.getElementById('rt-sonde-skewt-panel');
        if (panel) panel.style.display = 'none';
        try { Plotly.purge('rt-sonde-skewt'); } catch (e) { /* ok */ }
        // Clear dropdown selection
        var sel = document.getElementById('rt-sonde-select');
        if (sel) sel.value = '';
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) sel2.value = '';
    };

    // ── Populate dropsonde selector dropdowns ────────────────────
    function _rtPopulateSondeDropdowns() {
        if (!_rtSondeData || !_rtSondeData.dropsondes) return;
        var sondes = _rtSondeData.dropsondes;

        var optionsHtml = '<option value="">\uD83E\uDE82 Select Sonde\u2026</option>';
        for (var i = 0; i < sondes.length; i++) {
            var s = sondes[i];
            var tOff = s.time_offset_min != null ?
                (s.time_offset_min >= 0 ? '+' : '') + s.time_offset_min.toFixed(0) + 'm' : '';
            var label = (s.sonde_id || '#' + (i + 1));
            if (tOff) label += ' (' + tOff + ')';
            if (s.comments) label += ' \u2014 ' + s.comments;
            optionsHtml += '<option value="' + i + '">' + label + '</option>';
        }

        // Main dropdown (below action buttons)
        var sel = document.getElementById('rt-sonde-select');
        if (sel) {
            sel.innerHTML = optionsHtml;
            sel.disabled = false;
            sel.style.display = '';
        }

        // Skew-T panel dropdown (for quick switching)
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) {
            sel2.innerHTML = optionsHtml;
        }
    }

    // ── Select sonde from dropdown ───────────────────────────────
    window.rtSelectSonde = function (val) {
        if (val === '' || val == null) return;
        var idx = parseInt(val, 10);
        if (isNaN(idx)) return;

        // Ensure sondes are visible
        if (_rtSondeMode === 'off' && _rtSondeData) {
            _rtSondeMode = 'on';
            _rtSondeVisible = true;
            _rtSetTDRVisible(true);
            _rtRenderSondesOnMap();
            _rtRenderSondesOnPlot();
            _rtUpdateSondeBtn();
        }

        // Show the Skew-T
        _rtShowSondeSkewT(idx);

        // Sync both dropdowns
        var sel = document.getElementById('rt-sonde-select');
        if (sel) sel.value = val;
        var sel2 = document.getElementById('rt-skewt-sonde-select');
        if (sel2) sel2.value = val;
    };

    // ── 3D Volume: Toggle TDR isosurfaces ────────────────────────
    window.rtToggle3DTDR = function () {
        var btn = document.getElementById('vol-tdr-toggle');
        var chartDiv = document.getElementById('vol-3d-chart');
        if (!btn || !chartDiv || !chartDiv.data || chartDiv.data.length < 1) return;

        btn.classList.toggle('active');
        var vis = btn.classList.contains('active');
        Plotly.restyle(chartDiv, { visible: vis }, [0]);
    };

    // ── 3D Volume: Toggle dropsonde traces ───────────────────────
    window.rtToggle3DSondes = function () {
        var btn = document.getElementById('vol-sonde-toggle');
        var chartDiv = document.getElementById('vol-3d-chart');
        if (!btn || !chartDiv || !chartDiv.data) return;
        if (_rt3DSondeTraceStart < 0) return;

        btn.classList.toggle('active');
        var vis = btn.classList.contains('active');

        // Sonde traces are indices _rt3DSondeTraceStart to end
        var indices = [];
        for (var i = _rt3DSondeTraceStart; i < chartDiv.data.length; i++) {
            indices.push(i);
        }
        if (indices.length > 0) {
            Plotly.restyle(chartDiv, { visible: vis }, indices);
        }
    };

    // ── 3D Volume: Add sonde trajectories ────────────────────────
    function _rtAddSondesTo3D() {
        if (!_rtSondeVisible || !_rtSondeData || !_rtSondeData.dropsondes.length) return;
        var chartDiv = document.getElementById('vol-3d-chart');
        if (!chartDiv || !chartDiv.data) return;

        var sondeTraces = [];
        _rtSondeData.dropsondes.forEach(function (sonde, idx) {
            var p = sonde.profile;
            if (!p.x_km || p.x_km.length < 2) return;

            var color = _sondeColor(idx);

            // Build arrays filtering nulls
            var xs = [], ys = [], zs = [], texts = [], colors = [];
            for (var i = 0; i < p.x_km.length; i++) {
                if (p.x_km[i] != null && p.y_km[i] != null && p.alt_km[i] != null) {
                    xs.push(p.x_km[i]);
                    ys.push(p.y_km[i]);
                    zs.push(p.alt_km[i]);
                    var wspd = p.wspd[i];
                    colors.push(wspd != null ? wspd : 0);
                    texts.push(
                        '<b>\uD83E\uDE82 ' + sonde.sonde_id + '</b>' +
                        '<br>Alt: ' + p.alt_km[i].toFixed(2) + ' km' +
                        (wspd != null ? '<br>Wind: ' + wspd.toFixed(1) + ' m/s' : '') +
                        (p.temp[i] != null ? '<br>Temp: ' + p.temp[i].toFixed(1) + ' \u00b0C' : '')
                    );
                }
            }

            if (xs.length < 2) return;

            sondeTraces.push({
                type: 'scatter3d',
                mode: 'lines+markers',
                x: xs, y: ys, z: zs,
                line: { color: colors, colorscale: 'Jet', width: 4, cmin: 0, cmax: 80 },
                marker: { size: 2, color: colors, colorscale: 'Jet', cmin: 0, cmax: 80 },
                text: texts,
                hoverinfo: 'text',
                showlegend: false,
                name: '\uD83E\uDE82 ' + (sonde.sonde_id || '#' + (idx + 1))
            });

            // Launch marker (larger, at top)
            sondeTraces.push({
                type: 'scatter3d',
                mode: 'markers',
                x: [xs[0]], y: [ys[0]], z: [zs[0]],
                marker: { size: 6, color: color, symbol: 'circle',
                          line: { color: '#fff', width: 1 } },
                hoverinfo: 'text',
                text: ['\uD83E\uDE82 Launch: ' + sonde.sonde_id],
                showlegend: false
            });

            // Surface marker
            sondeTraces.push({
                type: 'scatter3d',
                mode: 'markers',
                x: [xs[xs.length - 1]], y: [ys[ys.length - 1]], z: [zs[zs.length - 1]],
                marker: { size: 6, color: color, symbol: 'diamond',
                          line: { color: '#fff', width: 1 } },
                hoverinfo: 'text',
                text: ['\uD83E\uDE82 Surface: ' + sonde.sonde_id],
                showlegend: false
            });
        });

        if (sondeTraces.length > 0) {
            _rt3DSondeTraceStart = chartDiv.data.length; // before addTraces
            Plotly.addTraces(chartDiv, sondeTraces);
            // Enable and activate the Sondes toggle button
            var sondeBtn3D = document.getElementById('vol-sonde-toggle');
            if (sondeBtn3D) { sondeBtn3D.disabled = false; sondeBtn3D.classList.add('active'); }
        }
        // Reset TDR toggle to active state
        var tdrBtn3D = document.getElementById('vol-tdr-toggle');
        if (tdrBtn3D) tdrBtn3D.classList.add('active');
    }

    // ── Hook: patch rtExploreFile to reset sonde state ───────────
    var _origRtExploreFile = window.rtExploreFile;
    window.rtExploreFile = function () {
        _rtSondeCleanup();
        _origRtExploreFile();
    };

    // ── Hook: patch rtRenderPlot to re-add sondes after re-render ──
    var _origRtRenderPlot = rtRenderPlot;
    rtRenderPlot = function (json, resultDiv) {
        _origRtRenderPlot(json, resultDiv);
        // Enable sonde + FL buttons after plot loads
        var sondeBtn = document.getElementById('rt-sonde-btn');
        if (sondeBtn) sondeBtn.disabled = false;
        var flBtn = document.getElementById('rt-fl-btn');
        if (flBtn) flBtn.disabled = false;
        // Re-render sondes if they were visible
        if (_rtSondeVisible && _rtSondeData) {
            // Slight delay to ensure plot is fully rendered
            setTimeout(function () {
                _rtRenderSondesOnPlot();
                // Re-hide TDR if in "only" mode (since newPlot recreated all traces)
                if (_rtSondeMode === 'only') _rtSetTDRVisible(false);
            }, 100);
        }
    };

    // ── Hook: patch height slider to update sonde markers ────────
    var _origLevelSlider = document.getElementById('rt-level');
    if (_origLevelSlider) {
        var _origOninput = _origLevelSlider.oninput;
        _origLevelSlider.oninput = function () {
            if (_origOninput) _origOninput.call(this);
            document.getElementById('rt-level-val').textContent =
                parseFloat(this.value).toFixed(1) + ' km';
            if (_rtSondeVisible) {
                // Debounce: update after a short delay
                clearTimeout(_rtSondeLevelTimer);
                _rtSondeLevelTimer = setTimeout(_rtUpdateSondeLevel, 150);
            }
        };
    }
    var _rtSondeLevelTimer = null;

    // ── Hook: patch rtOpen3DModal to add sonde traces to 3D ──────
    var _origRtOpen3DModal = rtOpen3DModal;
    rtOpen3DModal = function () {
        _origRtOpen3DModal();
        _rt3DSondeTraceStart = -1; // reset for fresh 3D scene
        var sondeBtn3D = document.getElementById('vol-sonde-toggle');
        if (_rtSondeVisible && _rtSondeData && _rtSondeData.dropsondes.length > 0) {
            // Delay to ensure 3D scene is rendered
            setTimeout(function () { _rtAddSondesTo3D(); }, 500);
        } else {
            // No sondes — disable the toggle
            if (sondeBtn3D) { sondeBtn3D.disabled = true; sondeBtn3D.classList.remove('active'); }
        }
    };

    // ═══════════════════════════════════════════════════════════
    // Flight-Level (In Situ) Observations — IWG1/MELISSA
    // ═══════════════════════════════════════════════════════════

    var _rtFLData = null;               // cached API response (10-s avg, used for map)
    var _rtFLData1s = null;             // 1-second resolution data
    var _rtFLData10s = null;            // 10-second average data
    var _rtFLData30s = null;            // 30-second average data
    var _rtFLVisible = false;           // toggle state
    var _rtFLMode = 'off';             // 'off' | 'on'
    var _rtFLMapLayers = [];            // Leaflet layers for map view
    var _rtFLFetching = false;          // prevent duplicate fetches
    var _rtFLColorVar = 'fl_wspd_ms';  // which variable colours the track
    // Which resolutions are visible on the time series
    var _rtFLResVisible = { '1s': true, '10s': true, '30s': true };

    // Colour variable options for flight-level track
    var _FL_COLOR_VARS = {
        'fl_wspd_ms':   { label: 'FL Wind Speed',   units: 'm/s',  cmin: 0,   cmax: 80  },
        'slp_hpa':      { label: 'Sea-Level Pres',   units: 'hPa',  cmin: 880, cmax: 1015 },
        'temp_c':       { label: 'Temperature',      units: '\u00b0C',   cmin: 10,  cmax: 30  },
        'gps_alt_m':    { label: 'GPS Altitude',     units: 'm',    cmin: 0,   cmax: 5000 },
        'static_pres_hpa': { label: 'Static Pres',   units: 'hPa',  cmin: 500, cmax: 1020 },
    };

    // ── Wind speed → colour for flight-level (matches TDR Saffir-Simpson) ──
    function _flWindColor(wspd) {
        if (wspd == null || isNaN(wspd)) return '#6b7280';
        if (wspd < 17.5) return '#60a5fa';    // TD
        if (wspd < 33.0) return '#34d399';    // TS
        if (wspd < 43.0) return '#fbbf24';    // Cat 1
        if (wspd < 49.5) return '#fb923c';    // Cat 2
        if (wspd < 58.0) return '#f87171';    // Cat 3
        if (wspd < 70.5) return '#ef4444';    // Cat 4
        return '#dc2626';                      // Cat 5
    }

    // ── Generic colour interpolation for non-wind variables ──
    function _flColorInterpolate(val, cmin, cmax) {
        if (val == null || isNaN(val)) return '#6b7280';
        var frac = Math.max(0, Math.min(1, (val - cmin) / (cmax - cmin || 1)));
        // Blue → cyan → green → yellow → red gradient
        var stops = [
            [0.0,  96, 165, 250],   // blue
            [0.25,  6, 182, 212],   // cyan
            [0.5,  52, 211, 153],   // green
            [0.75,251, 191,  36],   // yellow
            [1.0, 239,  68,  68],   // red
        ];
        var lo = stops[0], hi = stops[stops.length - 1];
        for (var s = 0; s < stops.length - 1; s++) {
            if (frac >= stops[s][0] && frac <= stops[s + 1][0]) {
                lo = stops[s]; hi = stops[s + 1]; break;
            }
        }
        var t = (hi[0] === lo[0]) ? 0 : (frac - lo[0]) / (hi[0] - lo[0]);
        var r = Math.round(lo[1] + t * (hi[1] - lo[1]));
        var g = Math.round(lo[2] + t * (hi[2] - lo[2]));
        var b = Math.round(lo[3] + t * (hi[3] - lo[3]));
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function _flObsColor(obs) {
        var val = obs[_rtFLColorVar];
        if (_rtFLColorVar === 'fl_wspd_ms') {
            return _flWindColor(val);
        }
        var info = _FL_COLOR_VARS[_rtFLColorVar] || { cmin: 0, cmax: 100 };
        // Reverse for pressure (lower = more intense = red)
        if (_rtFLColorVar === 'slp_hpa' || _rtFLColorVar === 'static_pres_hpa') {
            return _flColorInterpolate(val, info.cmax, info.cmin);
        }
        return _flColorInterpolate(val, info.cmin, info.cmax);
    }

    // ── Cleanup on file switch ────────────────────────────────
    function _rtFLCleanup() {
        _rtFLData = null;
        _rtFLData1s = null;
        _rtFLData10s = null;
        _rtFLData30s = null;
        _rtFLVisible = false;
        _rtFLMode = 'off';
        _rtFLFetching = false;
        _rtRemoveFLFromMap();
        var btn = document.getElementById('rt-fl-btn');
        if (btn) { btn.textContent = '\u2708 FL Off'; btn.classList.remove('active'); }
    }

    // ── Leaflet Map: Render flight track ──────────────────────
    function _rtRenderFLOnMap() {
        _rtRemoveFLFromMap();
        if (!_rtMap || !_rtFLData || !_rtFLData.observations.length) return;

        var obs = _rtFLData.observations;

        // Draw coloured segments (each segment coloured by the chosen variable)
        for (var i = 0; i < obs.length - 1; i++) {
            var o1 = obs[i], o2 = obs[i + 1];
            if (o1.lat == null || o2.lat == null) continue;

            // Skip if gap is too large (> 120s between thinned points = likely data gap)
            if (Math.abs(o2.time_offset_s - o1.time_offset_s) > 120) continue;

            var color = _flObsColor(o1);
            var seg = L.polyline(
                [[o1.lat, o1.lon], [o2.lat, o2.lon]],
                { color: color, weight: 3.5, opacity: 0.9 }
            ).addTo(_rtMap);
            _rtFLMapLayers.push(seg);
        }

        // Add aircraft position marker at the analysis time (closest point to t=0)
        var closest = null;
        var closestDelta = Infinity;
        for (var j = 0; j < obs.length; j++) {
            var delta = Math.abs(obs[j].time_offset_s);
            if (delta < closestDelta) {
                closestDelta = delta;
                closest = obs[j];
            }
        }

        if (closest) {
            var acIcon = L.divIcon({
                className: 'fl-aircraft-icon',
                html: '<div style="font-size:16px;text-shadow:0 0 6px rgba(0,0,0,0.8);">\u2708</div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            var acMarker = L.marker([closest.lat, closest.lon], { icon: acIcon }).addTo(_rtMap);
            _rtFLMapLayers.push(acMarker);

            // Summary popup on the aircraft marker
            var sm = _rtFLData.summary || {};
            var popupHtml =
                '<div style="font-family:DM Sans,sans-serif;font-size:12px;line-height:1.6;min-width:200px;">' +
                '<strong style="font-size:13px;color:#60a5fa;">\u2708 Flight-Level Data</strong><br>' +
                '<span style="color:#aaa;">' + (_rtFLData.mission_id || '') + '</span><br>' +
                (sm.mean_alt_m != null ? 'Mean Alt: <strong>' + (sm.mean_alt_m / 1000).toFixed(1) + ' km</strong><br>' : '') +
                (sm.max_fl_wspd_ms != null ? 'Max FL Wind: <strong style="color:' + _flWindColor(sm.max_fl_wspd_ms) + ';">' + sm.max_fl_wspd_ms.toFixed(1) + ' m/s (' + (sm.max_fl_wspd_ms * 1.94384).toFixed(0) + ' kt)</strong><br>' : '') +
                (sm.min_slp_hpa != null ? 'Min SLP: <strong>' + sm.min_slp_hpa.toFixed(1) + ' hPa</strong><br>' : '') +
                '<span style="color:#aaa;font-size:10px;">' + (_rtFLData.n_obs_total || 0) + ' obs (\u00b1' + (_rtFLData.time_window_min || 45) + ' min)</span>' +
                '</div>';
            acMarker.bindPopup(popupHtml, { maxWidth: 300, minWidth: 220 });
        }

        // Inject colour-variable legend into map controls area
        _rtInjectFLLegend();
    }

    function _rtRemoveFLFromMap() {
        _rtFLMapLayers.forEach(function (layer) {
            if (_rtMap) _rtMap.removeLayer(layer);
        });
        _rtFLMapLayers = [];
        var legend = document.getElementById('rt-fl-legend');
        if (legend) legend.remove();
    }

    // ── Legend / colour variable selector (injected into map wrapper) ──
    function _rtInjectFLLegend() {
        var existing = document.getElementById('rt-fl-legend');
        if (existing) existing.remove();

        var wrapper = document.getElementById('rt-map-wrapper');
        if (!wrapper) return;

        var info = _FL_COLOR_VARS[_rtFLColorVar] || { label: 'Wind', units: 'm/s' };

        var legend = document.createElement('div');
        legend.id = 'rt-fl-legend';
        legend.className = 'rt-fl-legend';
        legend.innerHTML =
            '<div class="fl-legend-row">' +
            '<span class="fl-legend-label">\u2708 ' + info.label + ' (' + info.units + ')</span>' +
            '<select id="rt-fl-color-var" class="fl-legend-select" onchange="rtFLChangeColor(this.value)">' +
            Object.keys(_FL_COLOR_VARS).map(function (k) {
                var v = _FL_COLOR_VARS[k];
                return '<option value="' + k + '"' + (k === _rtFLColorVar ? ' selected' : '') + '>' + v.label + '</option>';
            }).join('') +
            '</select>' +
            '</div>' +
            '<div class="fl-legend-bar"></div>' +
            '<div class="fl-legend-range"><span>' + info.cmin + '</span><span>' + info.cmax + '</span></div>';
        wrapper.appendChild(legend);
    }

    window.rtFLChangeColor = function (varName) {
        if (_FL_COLOR_VARS[varName]) {
            _rtFLColorVar = varName;
            _rtRenderFLOnMap();
        }
    };

    // ── Toggle button handler ─────────────────────────────────
    window.rtToggleFlightLevel = function () {
        if (_rtFLFetching) return;

        if (!_rtFLData && _rtFLMode === 'off') {
            // First activation: fetch all 3 resolutions in parallel
            _rtFLFetching = true;
            var btn = document.getElementById('rt-fl-btn');
            if (btn) btn.textContent = '\u2708 Loading\u2026';

            var baseUrl = API_BASE + RT_PREFIX + '/flightlevel?file_url=' + encodeURIComponent(_currentFileUrl);
            var fetchJson = function (url) {
                return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
            };

            Promise.all([
                fetchJson(baseUrl + '&avg_interval_s=1'),
                fetchJson(baseUrl + '&avg_interval_s=10'),
                fetchJson(baseUrl + '&avg_interval_s=30'),
            ])
                .then(function (results) {
                    _rtFLData1s  = results[0];
                    _rtFLData10s = results[1];
                    _rtFLData30s = results[2];
                    _rtFLData = _rtFLData10s;  // map uses 10-s avg
                    _rtFLFetching = false;

                    if (_rtFLData10s.n_obs === 0) {
                        rtToast('No flight-level data found within \u00b145 min' +
                            (_rtFLData10s.message ? ' (' + _rtFLData10s.message + ')' : ''), 'warn', 6000);
                        if (btn) btn.textContent = '\u2708 No FL Data';
                        return;
                    }

                    _rtFLVisible = true;
                    _rtFLMode = 'on';
                    if (btn) { btn.textContent = '\u2708 FL On'; btn.classList.add('active'); }
                    var _nTot = _rtFLData10s.n_obs_total;
                    var _maxW = _rtFLData10s.summary && _rtFLData10s.summary.max_fl_wspd_ms;
                    var _toastMsg = _nTot + ' obs \u2192 1s/' + _rtFLData1s.n_obs +
                        ', 10s/' + _rtFLData10s.n_obs + ', 30s/' + _rtFLData30s.n_obs;
                    if (_maxW != null) _toastMsg += ' \u00b7 Max FL wind ' + _maxW.toFixed(1) + ' m/s';
                    rtToast(_toastMsg, 'info', 6000);

                    _rtRenderFLOnMap();
                    _rtRenderFLTimeSeries();
                })
                .catch(function (err) {
                    _rtFLFetching = false;
                    if (btn) btn.textContent = '\u2708 FL Off';
                    rtToast('Flight-level fetch failed: ' + err.message, 'error');
                });
            return;
        }

        // Simple toggle: on → off → on
        if (_rtFLMode === 'on') {
            _rtFLMode = 'off';
            _rtFLVisible = false;
            _rtRemoveFLFromMap();
            window.rtFLCloseTimeSeries();
            var offBtn = document.getElementById('rt-fl-btn');
            if (offBtn) { offBtn.textContent = '\u2708 FL Off'; offBtn.classList.remove('active'); }
        } else {
            _rtFLMode = 'on';
            _rtFLVisible = true;
            _rtRenderFLOnMap();
            _rtRenderFLTimeSeries();
            var onBtn = document.getElementById('rt-fl-btn');
            if (onBtn) {
                onBtn.textContent = '\u2708 FL On';
                onBtn.classList.add('active');
            }
        }
    };

    // ═══════════════════════════════════════════════════════════
    // Along-Track Time Series (Phase 3)
    // ═══════════════════════════════════════════════════════════

    var _rtFLTSHighlight = null;  // Leaflet marker for click-highlight on map

    // Variable config for time series traces
    var _FL_TS_CONFIG = {
        'fl_wspd_ms':      { label: 'FL Wind Speed',   units: 'm/s',  color: '#60a5fa', yaxis: 'y'  },
        'slp_hpa':         { label: 'Sea-Level Pres',   units: 'hPa',  color: '#fbbf24', yaxis: 'y2' },
        'static_pres_hpa': { label: 'Static Pressure',  units: 'hPa',  color: '#fb923c', yaxis: 'y2' },
        'temp_c':          { label: 'Temperature',      units: '\u00b0C',   color: '#f87171', yaxis: 'y3' },
        'dewpoint_c':      { label: 'Dewpoint',         units: '\u00b0C',   color: '#a78bfa', yaxis: 'y3' },
        'gps_alt_m':       { label: 'GPS Altitude',     units: 'm',    color: '#6b7280', yaxis: 'y4' },
    };

    // Resolution style config: line weight + opacity for each averaging window
    var _FL_RES_STYLE = {
        '1s':  { width: 0.7, opacity: 0.35, dash: 'solid', suffix: ' (1 s)'  },
        '10s': { width: 1.8, opacity: 0.85, dash: 'solid', suffix: ' (10 s)' },
        '30s': { width: 3.0, opacity: 1.0,  dash: 'solid', suffix: ' (30 s)' },
    };

    // Helper: get data for a resolution key
    function _flDataForRes(resKey) {
        if (resKey === '1s')  return _rtFLData1s;
        if (resKey === '10s') return _rtFLData10s;
        if (resKey === '30s') return _rtFLData30s;
        return null;
    }

    // Show/update the time series panel when FL data is available
    function _rtRenderFLTimeSeries() {
        var panel = document.getElementById('rt-fl-timeseries-panel');
        if (!panel || !_rtFLData10s || !_rtFLData10s.observations || _rtFLData10s.observations.length === 0) return;

        panel.style.display = 'block';

        // Get selected variables
        var selectEl = document.getElementById('rt-fl-ts-vars');
        var selectedVars = [];
        if (selectEl) {
            for (var i = 0; i < selectEl.options.length; i++) {
                if (selectEl.options[i].selected) selectedVars.push(selectEl.options[i].value);
            }
        }
        if (selectedVars.length === 0) selectedVars = ['fl_wspd_ms'];

        // Determine which y-axes are needed and build traces
        var usedAxes = {};
        var traces = [];
        var resKeys = ['1s', '10s', '30s'];  // render order: 1s behind, 30s on top

        selectedVars.forEach(function (varName) {
            var cfg = _FL_TS_CONFIG[varName];
            if (!cfg) return;

            resKeys.forEach(function (resKey) {
                if (!_rtFLResVisible[resKey]) return;
                var data = _flDataForRes(resKey);
                if (!data || !data.observations || data.observations.length === 0) return;

                usedAxes[cfg.yaxis] = true;
                var obs = data.observations;
                var style = _FL_RES_STYLE[resKey];

                // Pre-round time to 1 decimal to avoid floating-point noise in hover
                var times = obs.map(function (o) { return Math.round(o.time_offset_s / 6.0) / 10.0; });
                var vals  = obs.map(function (o) {
                    var v = o[varName];
                    return (v != null && isFinite(v)) ? Math.round(v * 10) / 10 : null;
                });

                // Build customdata: [utc_time_str, knots_str]
                var isWind = (varName === 'fl_wspd_ms');
                var customdata = obs.map(function (o) {
                    // Extract HH:MM:SS from ISO timestamp (e.g. "2025-10-28T13:49:08Z")
                    var utc = '';
                    if (o.time) {
                        var tIdx = o.time.indexOf('T');
                        utc = tIdx >= 0 ? o.time.substring(tIdx + 1).replace('Z', '') : o.time;
                    }
                    var kt = '';
                    if (isWind) {
                        var v = o[varName];
                        if (v != null && isFinite(v)) kt = (v * 1.94384).toFixed(1);
                    }
                    return [utc, kt];
                });

                var hoverTpl;
                if (isWind) {
                    hoverTpl = cfg.label + style.suffix + ': %{y} ' + cfg.units +
                        ' (%{customdata[1]} kt)<br>%{customdata[0]} UTC · T%{x:+} min<extra></extra>';
                } else {
                    hoverTpl = cfg.label + style.suffix + ': %{y} ' + cfg.units +
                        '<br>%{customdata[0]} UTC · T%{x:+} min<extra></extra>';
                }

                traces.push({
                    x: times,
                    y: vals,
                    customdata: customdata,
                    name: cfg.label + style.suffix,
                    legendgroup: varName,
                    showlegend: resKey === '10s',  // only show one legend entry per variable
                    type: 'scatter',
                    mode: 'lines',
                    line: { color: cfg.color, width: style.width, dash: style.dash },
                    opacity: style.opacity,
                    yaxis: cfg.yaxis,
                    hovertemplate: hoverTpl,
                    connectgaps: false,
                });
            });
        });

        // Layout with up to 4 y-axes
        var gridColor = 'rgba(148,163,184,0.08)';
        var layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(10,15,25,0.5)',
            margin: { l: 55, r: 55, t: 8, b: 40 },
            font: { family: 'DM Sans, sans-serif', size: 11, color: '#94a3b8' },
            legend: {
                orientation: 'v', x: 1.0, xanchor: 'right', y: 1.0, yanchor: 'top',
                font: { size: 9 }, bgcolor: 'rgba(10,15,25,0.7)',
                bordercolor: 'rgba(148,163,184,0.15)', borderwidth: 1,
                traceorder: 'grouped', tracegroupgap: 4,
            },
            hovermode: 'x unified',
            xaxis: {
                title: { text: 'Minutes from Analysis Time', font: { size: 11 } },
                color: '#94a3b8',
                gridcolor: gridColor,
                zeroline: true,
                zerolinecolor: 'rgba(96,165,250,0.5)',
                zerolinewidth: 2,
            },
            yaxis: {
                title: usedAxes['y'] ? { text: 'Wind Speed (m/s)', font: { size: 10, color: '#60a5fa' } } : undefined,
                color: '#60a5fa',
                gridcolor: gridColor,
                side: 'left',
                visible: !!usedAxes['y'],
            },
            yaxis2: {
                title: usedAxes['y2'] ? { text: 'Pressure (hPa)', font: { size: 10, color: '#fbbf24' } } : undefined,
                color: '#fbbf24',
                overlaying: 'y',
                side: 'right',
                gridcolor: 'transparent',
                visible: !!usedAxes['y2'],
                autorange: 'reversed',
            },
            yaxis3: {
                title: usedAxes['y3'] ? { text: 'Temp (\u00b0C)', font: { size: 10, color: '#f87171' } } : undefined,
                color: '#f87171',
                overlaying: 'y',
                side: 'left',
                position: 0.0,
                anchor: 'free',
                gridcolor: 'transparent',
                visible: !!usedAxes['y3'],
            },
            yaxis4: {
                title: usedAxes['y4'] ? { text: 'Altitude (m)', font: { size: 10, color: '#6b7280' } } : undefined,
                color: '#6b7280',
                overlaying: 'y',
                side: 'right',
                anchor: 'free',
                position: 1.0,
                gridcolor: 'transparent',
                visible: !!usedAxes['y4'],
            },
            shapes: [{
                type: 'line',
                x0: 0, x1: 0,
                y0: 0, y1: 1,
                yref: 'paper',
                line: { color: 'rgba(96,165,250,0.6)', width: 2, dash: 'dash' },
            }],
            annotations: [{
                x: 0.5, y: 0,
                yref: 'paper',
                xref: 'x',
                text: 'TDR Analysis',
                showarrow: false,
                font: { size: 9, color: 'rgba(96,165,250,0.7)' },
                yanchor: 'top',
                yshift: 8,
            }],
        };

        // ── Build max-wind inset annotation ──────────────────────
        var insetLines = [];
        var windVars = [
            { key: 'fl_wspd_ms',   label: 'FL Wind',   summaryKey: 'max_fl_wspd_ms' },
        ];
        windVars.forEach(function (wv) {
            // Only show if the variable is selected in the multi-select
            if (selectedVars.indexOf(wv.key) === -1) return;
            var row = [];
            resKeys.forEach(function (resKey) {
                if (!_rtFLResVisible[resKey]) return;
                var data = _flDataForRes(resKey);
                if (!data || !data.observations || data.observations.length === 0) return;
                // Compute max from observations
                var maxVal = null;
                data.observations.forEach(function (o) {
                    var v = o[wv.key];
                    if (v != null && (maxVal === null || v > maxVal)) maxVal = v;
                });
                if (maxVal != null) {
                    row.push(resKey + ': <b>' + maxVal.toFixed(1) + '</b>');
                }
            });
            if (row.length > 0) {
                insetLines.push(wv.label + ' max — ' + row.join('  '));
            }
        });
        // Also show min pressure if pressure is selected
        var presVars = [
            { key: 'static_pres_hpa', label: 'Static P min' },
            { key: 'slp_hpa',         label: 'SLP min' },
        ];
        presVars.forEach(function (pv) {
            if (selectedVars.indexOf(pv.key) === -1) return;
            var row = [];
            resKeys.forEach(function (resKey) {
                if (!_rtFLResVisible[resKey]) return;
                var data = _flDataForRes(resKey);
                if (!data || !data.observations || data.observations.length === 0) return;
                var minVal = null;
                data.observations.forEach(function (o) {
                    var v = o[pv.key];
                    if (v != null && (minVal === null || v < minVal)) minVal = v;
                });
                if (minVal != null) {
                    row.push(resKey + ': <b>' + minVal.toFixed(1) + '</b>');
                }
            });
            if (row.length > 0) {
                insetLines.push(pv.label + ' — ' + row.join('  '));
            }
        });

        if (insetLines.length > 0) {
            layout.annotations.push({
                x: 0.01,
                y: 0.98,
                xref: 'paper',
                yref: 'paper',
                text: insetLines.join('<br>'),
                showarrow: false,
                font: { family: 'JetBrains Mono, monospace', size: 10, color: '#cbd5e1' },
                align: 'left',
                xanchor: 'left',
                yanchor: 'top',
                bgcolor: 'rgba(10,15,25,0.75)',
                bordercolor: 'rgba(96,165,250,0.3)',
                borderwidth: 1,
                borderpad: 6,
            });
        }

        var config = {
            responsive: true,
            displayModeBar: false,
            scrollZoom: false,
        };

        var plotDiv = document.getElementById('rt-fl-ts-plot');
        if (!plotDiv) return;

        Plotly.newPlot(plotDiv, traces, layout, config);

        // Click-to-highlight: find nearest point in 10-s data for map marker
        plotDiv.on('plotly_click', function (eventData) {
            if (!eventData || !eventData.points || !eventData.points.length) return;
            var pt = eventData.points[0];
            var clickTimeMin = pt.x;  // minutes from analysis

            // Find closest 10-s observation to the clicked time
            var obs10 = _rtFLData10s.observations;
            var bestIdx = 0, bestDelta = Infinity;
            for (var k = 0; k < obs10.length; k++) {
                var d = Math.abs(obs10[k].time_offset_s / 60.0 - clickTimeMin);
                if (d < bestDelta) { bestDelta = d; bestIdx = k; }
            }
            var o = obs10[bestIdx];
            if (o.lat == null || o.lon == null) return;

            // Remove previous highlight marker
            if (_rtFLTSHighlight && _rtMap) {
                _rtMap.removeLayer(_rtFLTSHighlight);
            }

            var hlIcon = L.divIcon({
                className: '',
                html: '<div style="width:14px;height:14px;background:rgba(96,165,250,0.9);border-radius:50%;border:2px solid #fff;box-shadow:0 0 10px rgba(96,165,250,0.8);"></div>',
                iconSize: [14, 14],
                iconAnchor: [7, 7],
            });
            _rtFLTSHighlight = L.marker([o.lat, o.lon], { icon: hlIcon, zIndexOffset: 1000 }).addTo(_rtMap);

            // Build popup with all 3 resolutions at this time
            var popTxt = '<div style="font-family:DM Sans,sans-serif;font-size:11px;line-height:1.5;">' +
                '<strong style="color:#60a5fa;">T' + (o.time_offset_s >= 0 ? '+' : '') + (o.time_offset_s / 60).toFixed(1) + ' min</strong><br>';
            if (o.fl_wspd_ms != null) popTxt += 'FL Wind (10s): <strong>' + o.fl_wspd_ms.toFixed(1) + ' m/s (' + (o.fl_wspd_ms * 1.94384).toFixed(0) + ' kt)</strong><br>';
            if (o.fl_wdir_deg != null) popTxt += 'FL Dir: ' + o.fl_wdir_deg.toFixed(0) + '\u00b0<br>';
            if (o.slp_hpa != null) popTxt += 'SLP: <strong>' + o.slp_hpa.toFixed(1) + ' hPa</strong><br>';
            if (o.static_pres_hpa != null) popTxt += 'Static P: ' + o.static_pres_hpa.toFixed(1) + ' hPa<br>';
            if (o.temp_c != null) popTxt += 'Temp: ' + o.temp_c.toFixed(1) + '\u00b0C<br>';
            if (o.gps_alt_m != null) popTxt += 'Alt: ' + o.gps_alt_m.toFixed(0) + ' m';
            popTxt += '</div>';

            _rtFLTSHighlight.bindPopup(popTxt, { maxWidth: 250, minWidth: 180 }).openPopup();
            _rtMap.panTo([o.lat, o.lon], { animate: true, duration: 0.3 });
        });
    }

    // Resolution toggle handler
    window.rtFLToggleRes = function (resKey) {
        _rtFLResVisible[resKey] = !_rtFLResVisible[resKey];
        // Update button visual
        var btn = document.getElementById('rt-fl-res-' + resKey);
        if (btn) {
            if (_rtFLResVisible[resKey]) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
        _rtRenderFLTimeSeries();
    };

    window.rtFLUpdateTimeSeries = function () {
        _rtRenderFLTimeSeries();
    };

    window.rtFLCloseTimeSeries = function () {
        var panel = document.getElementById('rt-fl-timeseries-panel');
        if (panel) panel.style.display = 'none';
        var plotDiv = document.getElementById('rt-fl-ts-plot');
        if (plotDiv) Plotly.purge(plotDiv);
        if (_rtFLTSHighlight && _rtMap) {
            _rtMap.removeLayer(_rtFLTSHighlight);
            _rtFLTSHighlight = null;
        }
    };

    // ── Patch rtExploreFile to clean up flight-level state ──────
    var _origRtExploreFile2 = window.rtExploreFile;
    window.rtExploreFile = function () {
        _rtFLCleanup();
        window.rtFLCloseTimeSeries();
        _origRtExploreFile2();
    };

    // ── Patch _rtCleanupMap to also remove FL layers ──────────
    var _origCleanupMap2 = _rtCleanupMap;
    _rtCleanupMap = function () {
        _rtRemoveFLFromMap();
        if (_rtFLTSHighlight) {
            _rtMap.removeLayer(_rtFLTSHighlight);
            _rtFLTSHighlight = null;
        }
        _origCleanupMap2();
    };

})();
