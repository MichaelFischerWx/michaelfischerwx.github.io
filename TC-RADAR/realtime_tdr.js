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
                // All requests finished but some frames had no data
                statusText = 'IR: ' + _rtIRLoadedCount + ' of ' + n + ' available';
            }
            _rtUpdateIRLoadingText(statusText);
            if (_rtIRLoadedCount >= 2) _rtEnableIRAnimControls();
            // Auto-start animation when we have 2 frames
            if (_rtIRLoadedCount === 2 && !_rtMapIRAnimPlaying) {
                rtMapIRAnimToggle();
            }
            // All requests completed (whether successful or not)
            if (completedCount >= totalToFetch) {
                _rtIRAllLoaded = true;
                _rtIRFetching = false;
                _rtRemoveIRLoadingIndicator();
            }
        }

        for (var i = startIdx; i < n; i++) {
            (function (idx) {
                var url = API_BASE + RT_PREFIX + '/ir_frame?file_url=' +
                    encodeURIComponent(_currentFileUrl) + '&frame_index=' + idx;
                fetch(url)
                    .then(function (r) {
                        if (!r.ok) { console.warn('IR frame ' + idx + ' HTTP ' + r.status); return null; }
                        return r.json();
                    })
                    .then(function (data) {
                        if (!_rtIRData) return;
                        if (data && data.frame) {
                            _rtIRFrameURLs[data.frame_index] = data.frame;
                            _rtPreDecodeIRFrame(data.frame_index, data.frame);
                        }
                        _checkAllDone();
                    })
                    .catch(function (err) {
                        console.warn('IR frame ' + idx + ' error:', err.message || err);
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
    function _rtSondeCleanup() {
        _rtSondeData = null;
        _rtSondeVisible = false;
        _rtSondeFetching = false;
        _rtSondeTraceCount = 0;
        _rtRemoveSondesFromMap();
        var btn = document.getElementById('rt-sonde-btn');
        if (btn) {
            btn.disabled = true;
            btn.classList.remove('active');
            btn.textContent = '\uD83E\uDE82 Sondes Off';
        }
    }

    // ── Toggle button handler ────────────────────────────────────
    window.rtToggleDropsondes = function () {
        if (_rtSondeFetching) return;

        if (!_rtSondeData && !_rtSondeVisible) {
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
                    if (btn) { btn.classList.add('active'); btn.textContent = '\uD83E\uDE82 Sondes On (' + json.n_sondes + ')'; }
                    rtToast(json.n_sondes + ' dropsonde' + (json.n_sondes > 1 ? 's' : '') + ' loaded', 'info', 4000);

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

        // Toggle visibility
        _rtSondeVisible = !_rtSondeVisible;
        var btn2 = document.getElementById('rt-sonde-btn');
        if (_rtSondeVisible) {
            if (btn2) { btn2.classList.add('active'); btn2.textContent = '\uD83E\uDE82 Sondes On (' + (_rtSondeData ? _rtSondeData.n_sondes : 0) + ')'; }
            _rtRenderSondesOnMap();
            _rtRenderSondesOnPlot();
        } else {
            if (btn2) { btn2.classList.remove('active'); btn2.textContent = '\uD83E\uDE82 Sondes Off'; }
            _rtRemoveSondesFromMap();
            _rtRemoveSondesFromPlot();
        }
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

        _rtSondeData.dropsondes.forEach(function (sonde, idx) {
            var p = sonde.profile;
            if (!p.x_km || p.x_km.length < 2) return;

            var color = _sondeColor(idx);

            // Full trajectory line (faded)
            var trajX = [], trajY = [];
            for (var i = 0; i < p.x_km.length; i++) {
                if (p.x_km[i] != null && p.y_km[i] != null) {
                    trajX.push(p.x_km[i]);
                    trajY.push(p.y_km[i]);
                }
            }
            traces.push({
                x: trajX, y: trajY, type: 'scatter', mode: 'lines',
                line: { color: color, width: 1.5, dash: 'dot' },
                opacity: 0.4,
                hoverinfo: 'skip',
                showlegend: false,
                _rtSonde: true
            });

            // Launch marker (top)
            traces.push({
                x: [sonde.launch.x_km], y: [sonde.launch.y_km],
                type: 'scatter', mode: 'markers',
                marker: { symbol: 'circle-open', size: 7, color: color, line: { width: 1.5, color: color } },
                hoverinfo: 'text',
                hovertext: ['\uD83E\uDE82 Launch: ' + (sonde.launch.alt_m / 1000).toFixed(1) + ' km\n' + sonde.sonde_id],
                showlegend: false,
                _rtSonde: true
            });

            // Surface marker (bottom)
            traces.push({
                x: [sonde.surface.x_km], y: [sonde.surface.y_km],
                type: 'scatter', mode: 'markers',
                marker: { symbol: 'diamond', size: 8, color: color },
                hoverinfo: 'text',
                hovertext: ['\uD83E\uDE82 Surface: ' + (sonde.surface.alt_m != null ? (sonde.surface.alt_m / 1000).toFixed(1) + ' km' : 'sfc') +
                    '\n' + sonde.sonde_id + (sonde.comments ? '\n' + sonde.comments : '')],
                showlegend: false,
                _rtSonde: true
            });

            // Interpolated position at current height level
            var interpPt = _rtInterpolateSondeAtLevel(p, currentLevel);
            if (interpPt) {
                // Get wind speed for color
                var wspdColor = interpPt.wspd != null ? _sondeWindColor(interpPt.wspd) : color;
                var wspdText = interpPt.wspd != null ? interpPt.wspd.toFixed(1) + ' m/s' : '';
                traces.push({
                    x: [interpPt.x], y: [interpPt.y],
                    type: 'scatter', mode: 'markers',
                    marker: {
                        symbol: 'circle', size: 11, color: wspdColor,
                        line: { color: '#fff', width: 2 }
                    },
                    hoverinfo: 'text',
                    hovertext: ['\uD83E\uDE82 ' + sonde.sonde_id +
                        '\n@ ' + currentLevel.toFixed(1) + ' km' +
                        (wspdText ? '\nWind: ' + wspdText : '') +
                        (interpPt.temp != null ? '\nTemp: ' + interpPt.temp.toFixed(1) + ' \u00b0C' : '')],
                    showlegend: false,
                    _rtSonde: true
                });
            }
        });

        if (traces.length > 0) {
            Plotly.addTraces(plotDiv, traces);
            _rtSondeTraceCount = traces.length;
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
                        '\uD83E\uDE82 ' + sonde.sonde_id +
                        '\nAlt: ' + p.alt_km[i].toFixed(2) + ' km' +
                        (wspd != null ? '\nWind: ' + wspd.toFixed(1) + ' m/s' : '') +
                        (p.temp[i] != null ? '\nTemp: ' + p.temp[i].toFixed(1) + ' \u00b0C' : '')
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
            Plotly.addTraces(chartDiv, sondeTraces);
        }
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
        // Enable sonde button after plot loads
        var sondeBtn = document.getElementById('rt-sonde-btn');
        if (sondeBtn) sondeBtn.disabled = false;
        // Re-render sondes if they were visible
        if (_rtSondeVisible && _rtSondeData) {
            // Slight delay to ensure plot is fully rendered
            setTimeout(function () { _rtRenderSondesOnPlot(); }, 100);
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
        if (_rtSondeVisible && _rtSondeData) {
            // Delay to ensure 3D scene is rendered
            setTimeout(function () { _rtAddSondesTo3D(); }, 500);
        }
    };

})();
