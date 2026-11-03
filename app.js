(function () {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const DEMO_STORAGE_KEY = "gym-rutina-demo-v1";
  const LOCAL_CACHE_KEY = "gym-rutina-cache-v2";

  const MUSCLES = ["PECHO", "BICEPS", "ESPALDA", "TRICEPS", "HOMBRO", "PIERNA"];
  const MUSCLE_LABELS = { PECHO: "Pecho", BICEPS: "Bíceps", ESPALDA: "Espalda", TRICEPS: "Tríceps", HOMBRO: "Hombro", PIERNA: "Pierna" };
  const PEOPLE = ["ISMAEL", "DAVID"];
  const PERSON_LABELS = { ISMAEL: "Ismael", DAVID: "David" };
  const INTENSITY_LABELS = { F: "Fuerte", N: "Normal", S: "Suave" };
  const WEEKDAY_FULL = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  // Plantilla semanal por defecto, indexada por Date#getDay() (0 = domingo … 6 = sábado).
  const DEFAULT_TEMPLATE = {
    0: [],
    1: [{ muscle: "ESPALDA", intensity: "F" }, { muscle: "BICEPS", intensity: "N" }],
    2: [{ muscle: "PECHO", intensity: "F" }, { muscle: "TRICEPS", intensity: "N" }],
    3: [{ muscle: "PIERNA", intensity: "N" }, { muscle: "HOMBRO", intensity: "F" }],
    4: [{ muscle: "ESPALDA", intensity: "N" }, { muscle: "BICEPS", intensity: "N" }],
    5: [{ muscle: "PECHO", intensity: "N" }, { muscle: "HOMBRO", intensity: "N" }, { muscle: "TRICEPS", intensity: "S" }],
    6: []
  };

  let state = emptyState();
  let demoMode = false;
  let dirty = false;
  let saving = false;
  let viewedDate = todayAtMidnight();
  let activeMuscle = MUSCLES[0];
  let activePerson = PEOPLE[0];
  let toastTimer;
  let localCacheReady = false;
  let localSaveTimer = null;
  let changeRevision = 0;
  let cloudRetryAfter = 0;
  let cloudRetryMs = 30000;
  let progressMetric = "estimated1RM";
  const PROGRESS_METRICS = {
    estimated1RM: { label: "1RM estimado", unit: "kg", color: "#2a4365" },
    maxWeight: { label: "Peso máximo", unit: "kg", color: "#1f7a4d" },
    volume: { label: "Volumen", unit: "kg·reps", color: "#b7791f" }
  };
  // Días tocados por persona desde la última sincronización, e ids de ejercicios borrados.
  // Al guardar solo se envían esos días; el resto se conserva tal cual está en Drive.
  const touched = Object.fromEntries(PEOPLE.map(person => [person, new Set()]));
  const deletedExerciseIds = new Set();
  function touch(date) { touched[activePerson].add(dateKey(date)); }

  function mergeWithRemote(remoteRaw) {
    const remote = normalizeState(remoteRaw);
    const merged = normalizeState(JSON.parse(JSON.stringify(remote)));
    MUSCLES.forEach(muscle => {
      const byId = new Map(remote.exercises[muscle].filter(item => !deletedExerciseIds.has(item.id)).map(item => [item.id, item]));
      state.exercises[muscle].forEach(item => byId.set(item.id, item));
      merged.exercises[muscle] = [...byId.values()];
    });
    PEOPLE.forEach(person => {
      touched[person].forEach(key => {
        const remoteDay = remote.sessions[person][key];
        if (remoteDay && remoteDay.locked) return;
        const localDay = state.sessions[person][key];
        if (localDay) merged.sessions[person][key] = localDay; else delete merged.sessions[person][key];
        const localPlan = state.overrides[person][key];
        if (localPlan) merged.overrides[person][key] = localPlan; else delete merged.overrides[person][key];
      });
    });
    merged.lastUpdated = new Date().toISOString();
    return merged;
  }

  function exerciseHistory(exerciseName) {
    const normalized = normalizeText(exerciseName);
    return Object.entries(currentSessions()).map(([key, session]) => {
      const entry = Object.entries(session.entries).find(([name]) => normalizeText(name) === normalized);
      if (!entry) return null;
      const sets = entry[1].rows.map(row => ({ weight: Number(row.weight), reps: Number(row.reps) }))
        .filter(row => Number.isFinite(row.weight) && row.weight > 0 && Number.isFinite(row.reps) && row.reps > 0);
      if (!sets.length) return null;
      const date = new Date(`${key}T00:00:00`);
      const estimates = sets.filter(row => row.reps <= 12).map(row => row.weight * (1 + row.reps / 30));
      return {
        key,
        date,
        sets: sets.length,
        maxWeight: Math.max(...sets.map(row => row.weight)),
        volume: sets.reduce((sum, row) => sum + row.weight * row.reps, 0),
        estimated1RM: estimates.length ? Math.max(...estimates) : null
      };
    }).filter(Boolean).sort((a, b) => a.date - b.date);
  }

  function openProgress(exerciseName) {
    const workouts = exerciseHistory(exerciseName);
    const metric = PROGRESS_METRICS[progressMetric];
    const chartWorkouts = workouts.filter(workout => Number.isFinite(workout[progressMetric]) && workout[progressMetric] > 0);
    const values = chartWorkouts.map(workout => workout[progressMetric]);
    const chartWidth = 680, chartHeight = 230, left = 44, right = 18, top = 24, bottom = 38;
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 0;
    const span = max - min || 1;
    const points = values.map((value, index) => {
      const x = values.length === 1 ? chartWidth / 2 : left + index * (chartWidth - left - right) / (values.length - 1);
      const y = top + (max - value) * (chartHeight - top - bottom) / span;
      return { x, y, value, workout: chartWorkouts[index] };
    });
    const polyline = points.map(point => `${point.x},${point.y}`).join(" ");
    const circles = points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4" fill="${metric.color}"><title>${formatDateShort(point.workout.date)}: ${formatProgressValue(point.value, metric)}</title></circle>`).join("");
    const axis = values.length === 1
      ? `<text x="${chartWidth / 2}" y="${chartHeight - 8}" text-anchor="middle" class="chart-label">${formatDateShort(chartWorkouts[0].date)}</text>`
      : values.length > 1
      ? `<text x="${left}" y="${chartHeight - 8}" class="chart-label">${formatDateShort(chartWorkouts[0].date)}</text><text x="${chartWidth - right}" y="${chartHeight - 8}" text-anchor="end" class="chart-label">${formatDateShort(chartWorkouts[chartWorkouts.length - 1].date)}</text>`
      : "";
    const latest = chartWorkouts[chartWorkouts.length - 1];
    const best = chartWorkouts.reduce((result, workout) => workout[progressMetric] > (result ? result[progressMetric] : -Infinity) ? workout : result, null);
    const tableRows = workouts.slice().reverse().slice(0, 12).map(workout => `<tr><td>${formatDateShort(workout.date)}</td><td>${formatProgressValue(workout.maxWeight, PROGRESS_METRICS.maxWeight)}</td><td>${formatProgressValue(workout.volume, PROGRESS_METRICS.volume)}</td><td>${workout.estimated1RM ? formatProgressValue(workout.estimated1RM, PROGRESS_METRICS.estimated1RM) : "—"}</td></tr>`).join("");
    $("#progress-dialog-body").innerHTML = `<span class="muted-small">${PERSON_LABELS[activePerson]} · ${workouts.length} entrenamientos registrados</span>
      <h3 id="progress-dialog-title">${escapeHtml(exerciseName)}</h3>
      <div class="progress-metrics"><div><span>Último ${metric.label.toLowerCase()}</span><strong>${latest ? formatProgressValue(latest[progressMetric], metric) : "—"}</strong></div><div><span>Mejor ${metric.label.toLowerCase()}</span><strong>${best ? formatProgressValue(best[progressMetric], metric) : "—"}</strong></div></div>
      <div class="progress-controls">${Object.entries(PROGRESS_METRICS).map(([key, item]) => `<button type="button" class="mini-button progress-metric${key === progressMetric ? " active" : ""}" data-metric="${key}">${item.label}</button>`).join("")}</div>
      ${workouts.length ? `<div class="progress-chart"><svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="${metric.label} por entrenamiento"><line x1="${left}" y1="${chartHeight - bottom}" x2="${chartWidth - right}" y2="${chartHeight - bottom}" class="chart-axis"/><line x1="${left}" y1="${top}" x2="${left}" y2="${chartHeight - bottom}" class="chart-axis"/>${points.length > 1 ? `<polyline points="${polyline}" fill="none" stroke="${metric.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` : ""}${circles}${axis}</svg></div>
      <p class="progress-note">El 1RM es una estimación deportiva calculada con la fórmula de Epley (solo series de hasta 12 repeticiones). Volumen = suma de kg × repeticiones de las series anotadas.</p>
      <div class="progress-table-wrap"><table class="progress-table"><thead><tr><th>Fecha</th><th>Peso máx.</th><th>Volumen</th><th>1RM est.</th></tr></thead><tbody>${tableRows}</tbody></table></div>` : `<div class="empty-state"><strong>Aún no hay sesiones para este ejercicio</strong>Al guardar pesos y repeticiones, aquí verás la evolución.</div>`}`;
    $$(".progress-metric").forEach(button => button.addEventListener("click", () => {
      progressMetric = button.dataset.metric;
      openProgress(exerciseName);
    }));
    if (!$("#progress-dialog").open) $("#progress-dialog").showModal();
  }

  function formatProgressValue(value, metric) {
    return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(value)} ${metric.unit}`;
  }

  function emptyState() {
    const exercises = {};
    MUSCLES.forEach(muscle => { exercises[muscle] = []; });
    const overrides = {};
    const sessions = {};
    PEOPLE.forEach(person => { overrides[person] = {}; sessions[person] = {}; });
    return { version: 2, exercises, overrides, sessions, lastUpdated: null };
  }

  function id() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function todayAtMidnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  function plusDays(date, amount) { const result = new Date(date); result.setDate(result.getDate() + amount); return result; }
  function normalizeText(text) { return String(text || "").trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
  function showToast(message) { const toast = $("#toast"); toast.textContent = message; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2900); }
  function setStatus(text, mode = "") { $("#sync-label").textContent = text; $("#sync-status").className = `sync-status ${mode}`; }
  function connected() { return window.gymDrive && window.gymDrive.isSignedIn(); }
  function canEdit() { return connected() || demoMode || localCacheReady; }
  function requireEditing() { if (canEdit()) return true; showToast("Pulsa «Probar sin Drive» o conecta Google Drive para empezar."); return false; }

  function updateSaveButton() {
    const button = $("#save-button");
    if (!button) return;
    button.disabled = !canEdit() || !dirty || saving;
    button.textContent = saving ? "Guardando…" : "Guardar";
    button.classList.toggle("has-changes", dirty);
  }

  function normalizeState(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const exercises = {};
    MUSCLES.forEach(muscle => {
      const list = value.exercises && Array.isArray(value.exercises[muscle]) ? value.exercises[muscle] : [];
      exercises[muscle] = list.filter(item => item && item.id && item.name).map(item => ({
        id: String(item.id),
        name: String(item.name).trim(),
        sets: Math.max(1, Math.round(Number(item.sets) || 1)),
        reps: Math.max(1, Math.round(Number(item.reps) || 1)),
        comment: String(item.comment || "").trim(),
        active: item.active !== false,
        days: Array.isArray(item.days) ? item.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : null
      }));
    });
    const overrides = {};
    const sessions = {};
    // Antes de añadir el soporte para varias personas, "overrides" y "sessions"
    // se guardaban como un mapa plano de fecha → datos. Si detectamos ese
    // formato antiguo, migramos todo ese histórico a la primera persona.
    const personKeyed = value.overrides && typeof value.overrides === "object" && PEOPLE.some(person => Object.prototype.hasOwnProperty.call(value.overrides, person));
    const legacyOverrides = personKeyed ? null : value.overrides;
    const legacySessions = personKeyed ? null : value.sessions;
    PEOPLE.forEach(person => {
      overrides[person] = normalizeOverridesMap(personKeyed ? value.overrides && value.overrides[person] : person === PEOPLE[0] ? legacyOverrides : null);
      sessions[person] = normalizeSessionsMap(personKeyed ? value.sessions && value.sessions[person] : person === PEOPLE[0] ? legacySessions : null);
    });
    return { version: 2, exercises, overrides, sessions, lastUpdated: value.lastUpdated || null };
  }

  function normalizeOverridesMap(rawMap) {
    const overrides = {};
    if (rawMap && typeof rawMap === "object") {
      Object.entries(rawMap).forEach(([key, plan]) => {
        if (Array.isArray(plan)) overrides[key] = plan.filter(item => item && MUSCLES.includes(item.muscle)).map(item => ({ muscle: item.muscle, intensity: ["F", "N", "S"].includes(item.intensity) ? item.intensity : "N", day: Number.isInteger(item.day) ? item.day : null }));
      });
    }
    return overrides;
  }

  function normalizeSessionsMap(rawMap) {
    const sessions = {};
    if (rawMap && typeof rawMap === "object") {
      Object.entries(rawMap).forEach(([key, session]) => {
        const entries = {};
        if (session && session.entries && typeof session.entries === "object") {
          Object.entries(session.entries).forEach(([name, data]) => {
            const rows = Array.isArray(data && data.rows) ? data.rows.map(row => ({ weight: row && row.weight != null ? String(row.weight) : "", reps: row && row.reps != null ? String(row.reps) : "" })) : [];
            entries[name] = { rows };
          });
        }
        sessions[key] = { entries, locked: !!(session && session.locked) };
      });
    }
    return sessions;
  }

  function persist() {
    if (!requireEditing()) return false;
    dirty = true;
    changeRevision += 1;
    scheduleLocalSave();
    setStatus(connected() ? "Cambios pendientes de Drive" : demoMode ? "Prueba · cambios sin guardar" : "Guardado local · pendiente de Drive");
    updateSaveButton();
    return true;
  }

  function cachePayload() {
    return {
      state,
      touched: Object.fromEntries(PEOPLE.map(person => [person, [...touched[person]]])),
      deletedExerciseIds: [...deletedExerciseIds],
      savedAt: new Date().toISOString()
    };
  }

  function writeLocalCache() {
    if (!localCacheReady && !canEdit()) return;
    try {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cachePayload()));
      localCacheReady = true;
    } catch (error) {
      console.error("No se pudo guardar la copia local", error);
      setStatus("No se pudo guardar localmente");
    }
  }

  function scheduleLocalSave() {
    clearTimeout(localSaveTimer);
    localSaveTimer = setTimeout(writeLocalCache, 250);
  }

  function restoreLocalCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "null");
      if (!cached || !cached.state) return false;
      state = normalizeState(cached.state);
      PEOPLE.forEach(person => {
        touched[person] = new Set(Array.isArray(cached.touched && cached.touched[person]) ? cached.touched[person] : []);
      });
      (Array.isArray(cached.deletedExerciseIds) ? cached.deletedExerciseIds : []).forEach(exerciseId => deletedExerciseIds.add(String(exerciseId)));
      localCacheReady = true;
      dirty = PEOPLE.some(person => touched[person].size) || deletedExerciseIds.size > 0;
      return true;
    } catch (error) {
      console.warn("No se pudo recuperar el borrador local", error);
      return false;
    }
  }

  async function saveChanges(options = {}) {
    if (!requireEditing() || saving) return false;
    if (options.automatic && Date.now() < cloudRetryAfter) return false;
    writeLocalCache();
    if (!dirty) { showToast("No hay cambios pendientes para guardar."); return true; }
    if (!connected()) {
      showToast("Cambios guardados en este dispositivo. Conecta Drive para sincronizarlos.");
      return true;
    }
    saving = true;
    setStatus("Guardando…", "busy");
    updateSaveButton();
    const revisionAtStart = changeRevision;
    try {
      if (demoMode && !connected()) {
        state.lastUpdated = new Date().toISOString();
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
        dirty = false;
        PEOPLE.forEach(person => touched[person].clear());
        deletedExerciseIds.clear();
        writeLocalCache();
        setStatus("Modo prueba · guardado local", "connected");
        if (!options.quiet) showToast("Guardado en este navegador (modo prueba).");
        return true;
      }

      // The main file is synced first; backup rotation is deliberately excluded from this critical path.
      const remote = await window.gymDrive.load();
      const before = JSON.stringify(state);
      state = mergeWithRemote(remote);
      const snapshot = JSON.stringify(state);
      if (JSON.stringify({ ...JSON.parse(before), lastUpdated: null }) !== JSON.stringify({ ...JSON.parse(snapshot), lastUpdated: null })) renderAll();
      await window.gymDrive.save(JSON.parse(snapshot));
      cloudRetryAfter = 0;
      cloudRetryMs = 30000;
      if (changeRevision === revisionAtStart) {
        dirty = false;
        PEOPLE.forEach(person => touched[person].clear());
        deletedExerciseIds.clear();
      } else {
        dirty = true;
      }
      setStatus(dirty ? "Hay cambios locales pendientes" : "Sincronizado con Drive", dirty ? "" : "connected");
      if (!dirty) writeLocalCache();
      if (options.backup && typeof window.gymDrive.saveBackup === "function") {
        window.gymDrive.saveBackup(JSON.parse(snapshot)).then(() => {
          if (!options.quiet) showToast("Día guardado en Drive con copia de seguridad.");
        }).catch(error => {
          console.error("Los datos se guardaron, pero falló la copia de seguridad", error);
          showToast("El día sí se guardó en Drive; no se pudo crear su copia de seguridad.");
        });
      } else if (!options.quiet) {
        showToast(dirty ? "Datos guardados; quedan cambios nuevos pendientes." : "Datos guardados en Drive.");
      }
      return !dirty;
    } catch (error) {
      console.error("No se pudo guardar", error);
      cloudRetryAfter = Date.now() + cloudRetryMs;
      cloudRetryMs = Math.min(cloudRetryMs * 2, 300000);
      setStatus("Guardado local · Drive pendiente", "");
      writeLocalCache();
      if (!connected()) {
        $("#connect-button").textContent = "Reconectar Drive";
        $("#connection-notice").classList.add("visible");
        enableEditing(localCacheReady);
      }
      if (!options.quiet) showToast(`El borrador está guardado en este dispositivo, pero Drive no confirmó la sincronización: ${error.message || "comprueba la conexión"}`);
      return false;
    } finally {
      saving = false;
      updateSaveButton();
    }
  }

  function onConnected(data) {
    if (dirty) {
      state = mergeWithRemote(data);
    } else {
      state = normalizeState(data);
      PEOPLE.forEach(person => touched[person].clear());
      deletedExerciseIds.clear();
    }
    demoMode = false;
    localCacheReady = true;
    renderAll();
    $("#connection-notice").classList.remove("visible");
    $("#connect-button").textContent = "Drive conectado";
    $("#connect-button").title = "Pulsa para desconectar";
    setStatus(dirty ? "Borrador local · sincronizando…" : "Sincronizado con Drive", dirty ? "busy" : "connected");
    enableEditing(true);
    writeLocalCache();
    if (dirty) saveChanges({ quiet: true });
  }

  async function connect(showErrors = true) {
    if (demoMode && dirty && !confirm("Hay cambios guardados localmente. Al conectar, se fusionarán con los datos de Drive. ¿Continuar?")) return;
    const buttons = [$("#connect-button"), $("#notice-connect")].filter(Boolean);
    buttons.forEach(button => { button.disabled = true; });
    setStatus("Conectando…", "busy");
    try {
      const data = await window.gymDrive.signIn();
      onConnected(data);
      showToast("¡Todo conectado! Ya puedes registrar tu entrenamiento.");
    } catch (error) {
      console.error("Error de conexión con Drive", error);
      setStatus(demoMode ? "Modo prueba · guardado local" : "No conectado", demoMode ? "connected" : "");
      if (!demoMode) $("#connection-notice").classList.add("visible");
      enableEditing(canEdit());
      if (showErrors) showToast(error.message || "No se pudo conectar con Google Drive.");
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  async function disconnect() {
    if (!connected()) return connect();
    if (dirty && !confirm("Hay cambios sin guardar. Si desconectas ahora, se perderán. ¿Quieres continuar?")) return;
    if (!confirm("¿Desconectar Google Drive? Los datos seguirán guardados en la nube.")) return;
    await window.gymDrive.signOut();
    state = emptyState();
    demoMode = false;
    dirty = false;
    renderAll();
    enableEditing(false);
    $("#connect-button").textContent = "Conectar Drive";
    $("#connect-button").title = "";
    $("#connection-notice").classList.add("visible");
    setStatus("Conecta para empezar");
  }

  function startDemo() {
    if (connected()) return;
    const hasLocalDraft = localCacheReady;
    if (!hasLocalDraft) {
      try {
        const saved = localStorage.getItem(DEMO_STORAGE_KEY);
        state = saved ? normalizeState(JSON.parse(saved)) : emptyState();
      } catch (error) {
        console.warn("No se pudieron recuperar los datos de prueba locales", error);
        state = emptyState();
      }
    }
    demoMode = true;
    localCacheReady = true;
    if (!hasLocalDraft) dirty = false;
    $("#connection-notice").classList.remove("visible");
    $("#connect-button").textContent = "Conectar Drive";
    $("#connect-button").title = "Los datos de prueba están guardados solo en este navegador.";
    setStatus("Modo prueba · guardado local", "connected");
    renderAll();
    enableEditing(true);
    showToast("Modo de prueba activo. Pulsa Guardar para conservar los cambios en este navegador.");
  }

  function enableEditing(enabled) {
    const exerciseForm = $("#exercise-form");
    [...exerciseForm.elements].forEach(control => { control.disabled = !enabled; });
    const dayClosed = isDayCompleted(viewedDate) || isDayLocked(viewedDate);
    $("#swap-select").disabled = !enabled || dayClosed;
    $("#swap-apply").disabled = !enabled || dayClosed;
    $("#swap-reset").disabled = !enabled;
    $$(".exercise-edit, .exercise-delete, .exercise-toggle, .day-chip, .finish-day").forEach(element => { element.disabled = !enabled; });
    $$(".set-input").forEach(element => { element.disabled = !enabled || isDayLocked(viewedDate); });
    updateSaveButton();
  }

  function switchPanel(name) {
    $$(".tab").forEach(tab => { const active = tab.dataset.panel === name; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); });
    $$(".panel").forEach(panel => { const active = panel.id === `panel-${name}`; panel.classList.toggle("active", active); panel.hidden = !active; });
  }

  // ---------- Rutina ----------

  function currentOverrides() { return state.overrides[activePerson]; }
  function currentSessions() { return state.sessions[activePerson]; }

  function getDefaultPlan(date) { return DEFAULT_TEMPLATE[date.getDay()].map(item => ({ ...item, day: date.getDay() })); }

  // Un ejercicio sin "days" aparece en todos los días en que toca su grupo muscular.
  function exerciseAppliesToDay(exercise, day) { return !exercise.days || day == null || exercise.days.includes(day); }
  function trainingDaysFor(muscle) { return [1, 2, 3, 4, 5, 6, 0].filter(day => DEFAULT_TEMPLATE[day].some(item => item.muscle === muscle)); }
  function getPlanForDate(date) {
    const key = dateKey(date);
    const overrides = currentOverrides();
    if (overrides[key]) return overrides[key].map(item => ({ ...item }));
    return getDefaultPlan(date);
  }

  function isDayLocked(date) {
    const session = currentSessions()[dateKey(date)];
    return !!(session && session.locked);
  }

  function isDayCompleted(date) {
    const session = currentSessions()[dateKey(date)];
    if (!session) return false;
    return Object.values(session.entries).some(entry => entry.rows.some(row => String(row.weight).trim() !== "" || String(row.reps).trim() !== ""));
  }

  function describePlan(plan) {
    if (!plan.length) return "Descanso";
    return plan.map(item => `${MUSCLE_LABELS[item.muscle]} ${INTENSITY_LABELS[item.intensity]}`).join(" + ");
  }

  function getSessionRows(date, exerciseName) {
    const key = dateKey(date);
    const session = currentSessions()[key];
    const normalized = normalizeText(exerciseName);
    if (!session) return [];
    const entry = Object.entries(session.entries).find(([name]) => normalizeText(name) === normalized);
    return entry ? entry[1].rows : [];
  }

  function setSessionRow(date, exerciseName, rowIndex, field, value) {
    const key = dateKey(date);
    const sessions = currentSessions();
    if (sessions[key] && sessions[key].locked) return;
    touch(date);
    if (!sessions[key]) sessions[key] = { entries: {}, locked: false };
    const session = sessions[key];
    let entryKey = Object.keys(session.entries).find(name => normalizeText(name) === normalizeText(exerciseName));
    if (!entryKey) { entryKey = exerciseName; session.entries[entryKey] = { rows: [] }; }
    const rows = session.entries[entryKey].rows;
    while (rows.length <= rowIndex) rows.push({ weight: "", reps: "" });
    rows[rowIndex][field] = value;
  }

  // Busca, retrocediendo día a día desde la fecha vista, la sesión anotada más
  // reciente (de la persona activa) en la que ese ejercicio (por nombre) tenga
  // datos. No se limita al mismo día de la semana, porque un mismo grupo
  // muscular puede tocar en días distintos (p. ej. Bíceps lunes y jueves).
  function findPreviousResult(date, exerciseName) {
    const normalized = normalizeText(exerciseName);
    const sessions = currentSessions();
    for (let daysBack = 1; daysBack <= 730; daysBack++) {
      const candidateDate = plusDays(date, -daysBack);
      const session = sessions[dateKey(candidateDate)];
      if (!session) continue;
      const entry = Object.entries(session.entries).find(([name]) => normalizeText(name) === normalized);
      if (!entry) continue;
      const rows = entry[1].rows.filter(row => String(row.weight).trim() !== "" || String(row.reps).trim() !== "");
      if (rows.length) return { date: candidateDate, rows: entry[1].rows };
    }
    return null;
  }

  function formatDateLong(date) { return `${WEEKDAY_FULL[date.getDay()][0].toUpperCase()}${WEEKDAY_FULL[date.getDay()].slice(1)}, ${date.getDate()} de ${MONTHS[date.getMonth()]} de ${date.getFullYear()}`; }
  function formatDateShort(date) { return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`; }

  function renderPersonTabs() {
    const container = $("#person-tabs");
    if (!container) return;
    container.innerHTML = PEOPLE.map(person => `<button type="button" class="person-tab${person === activePerson ? " active" : ""}" data-person="${person}" role="tab" aria-selected="${person === activePerson}">${PERSON_LABELS[person]}</button>`).join("");
    $$(".person-tab").forEach(button => button.addEventListener("click", () => {
      if (button.dataset.person === activePerson) return;
      activePerson = button.dataset.person;
      renderPersonTabs();
      renderRoutine();
    }));
  }

  function fillSwapSelect() {
    const select = $("#swap-select");
    select.innerHTML = "";
    for (let weekday = 1; weekday <= 6; weekday++) {
      const dayIndex = weekday % 7; // 1..6 lunes..sábado, luego domingo(0) al final
      const option = document.createElement("option");
      option.value = String(dayIndex);
      const label = WEEKDAY_FULL[dayIndex];
      option.textContent = `${label[0].toUpperCase()}${label.slice(1)} — ${describePlan(DEFAULT_TEMPLATE[dayIndex])}`;
      select.append(option);
    }
    const sundayOption = document.createElement("option");
    sundayOption.value = "0";
    sundayOption.textContent = "Domingo — Descanso";
    select.append(sundayOption);
  }

  function renderRoutine() {
    const key = dateKey(viewedDate);
    const plan = getPlanForDate(viewedDate);
    const locked = isDayLocked(viewedDate);
    const completed = isDayCompleted(viewedDate) || locked;
    const isToday = key === dateKey(todayAtMidnight());

    $("#day-label").textContent = formatDateLong(viewedDate);
    $("#day-sublabel").textContent = isToday ? "Hoy" : "";
    $("#swap-current-label").textContent = describePlan(plan);
    $("#swap-hint").textContent = locked
      ? "Día terminado y bloqueado: ya no se puede modificar."
      : completed
      ? "Ya has anotado datos este día, así que no se puede cambiar la rutina planificada."
      : "Puedes cambiarla por la rutina de otro día si aún no has registrado nada hoy.";
    $("#swap-select").disabled = completed || !canEdit();
    $("#swap-apply").disabled = completed || !canEdit();
    $("#swap-reset").hidden = !currentOverrides()[key];
    $("#swap-reset").disabled = !canEdit() || locked;
    renderFinish(plan.length > 0, locked);

    const container = $("#routine-day");
    container.innerHTML = "";

    if (!plan.length) {
      container.innerHTML = `<div class="rest-day"><strong>Día de descanso</strong>Hoy no toca entrenar según la rutina. Puedes intercambiarla arriba si quieres hacer otro grupo muscular.</div>`;
      return;
    }

    plan.forEach(item => {
      const block = document.createElement("article");
      block.className = "muscle-block card";
      const exercises = (state.exercises[item.muscle] || []).filter(exercise => (exercise.active && exerciseAppliesToDay(exercise, item.day)) || getSessionRows(viewedDate, exercise.name).length);
      const body = exercises.length
        ? exercises.map(exercise => renderExerciseCard(exercise)).join("")
        : `<p class="no-exercises-note">No hay ejercicios activos para ${MUSCLE_LABELS[item.muscle]}. Añade o activa alguno en la pestaña Ejercicios.</p>`;
      block.innerHTML = `<div class="muscle-block-header"><h3>${escapeHtml(MUSCLE_LABELS[item.muscle])}</h3><span class="intensity-badge intensity-${item.intensity}">${INTENSITY_LABELS[item.intensity]}</span></div><div class="muscle-block-body">${body}</div>`;
      container.append(block);
    });

    bindSetInputs();
  }

  function renderFinish(hasPlan, locked) {
    const box = $("#day-finish");
    if (!hasPlan) { box.innerHTML = ""; return; }
    box.innerHTML = locked
      ? `<div class="day-locked">Día terminado y bloqueado</div>`
      : `<button class="button button-primary finish-day" id="finish-day" type="button">Día terminado</button><span class="muted-small">Al terminar, el día se bloquea y ya no se podrá modificar.</span>`;
    const button = $("#finish-day");
    if (button) { button.disabled = !canEdit(); button.addEventListener("click", finishDay); }
  }

  function finishDay() {
    if (!requireEditing()) return;
    if (!confirm("¿Dar por terminado este día? Se bloqueará y no podrás modificarlo nunca más.")) return;
    const sessions = currentSessions();
    const key = dateKey(viewedDate);
    touch(viewedDate);
    if (!sessions[key]) sessions[key] = { entries: {}, locked: true };
    else sessions[key].locked = true;
    renderRoutine();
    persist();
    saveChanges({ backup: true });
  }

  function renderExerciseCard(exercise) {
    const previous = findPreviousResult(viewedDate, exercise.name);
    const loggedRows = getSessionRows(viewedDate, exercise.name);
    const rowCount = Math.max(exercise.sets, loggedRows.length);
    const previousHtml = previous
      ? `<div class="previous-result"><strong>Última vez (${formatDateShort(previous.date)})</strong>${previous.rows.map((row, index) => `Serie ${index + 1}: ${row.weight ? escapeHtml(row.weight) + " kg" : "—"} × ${row.reps ? escapeHtml(row.reps) : "—"} rep.`).join(" · ")}</div>`
      : "";
    const rowsHtml = Array.from({ length: rowCount }, (_, index) => {
      const row = loggedRows[index] || { weight: "", reps: "" };
      return `<div class="set-row">
        <span class="set-row-label">Serie ${index + 1}</span>
        <div class="set-input-wrap"><input class="input set-input" type="number" min="0" step="any" inputmode="decimal" placeholder="Peso" data-date="${dateKey(viewedDate)}" data-name="${escapeHtml(exercise.name)}" data-index="${index}" data-field="weight"${isDayLocked(viewedDate) ? " disabled" : ""} value="${escapeHtml(row.weight)}"><span>kg</span></div>
        <div class="set-input-wrap"><input class="input set-input" type="number" min="0" step="1" inputmode="numeric" placeholder="Reps" data-date="${dateKey(viewedDate)}" data-name="${escapeHtml(exercise.name)}" data-index="${index}" data-field="reps"${isDayLocked(viewedDate) ? " disabled" : ""} value="${escapeHtml(row.reps)}"><span>reps</span></div>
      </div>`;
    }).join("");
    return `<div class="exercise-card">
      <div class="exercise-card-header"><h4>${escapeHtml(exercise.name)}</h4><div class="exercise-card-actions"><span class="exercise-target">${exercise.sets} series × ${exercise.reps} repeticiones</span><button class="mini-button progress-button" type="button" data-name="${escapeHtml(exercise.name)}">Progreso</button></div></div>
      ${exercise.comment ? `<p class="exercise-comment-note">${escapeHtml(exercise.comment)}</p>` : ""}
      ${previousHtml}
      <div class="set-rows">${rowsHtml}</div>
    </div>`;
  }

  function bindSetInputs() {
    $$(".set-input").forEach(input => {
      input.disabled = !canEdit() || isDayLocked(viewedDate);
      input.addEventListener("input", () => {
        if (!requireEditing()) { input.value = ""; return; }
        const { date, name, index, field } = input.dataset;
        const parsedDate = new Date(`${date}T00:00:00`);
        setSessionRow(parsedDate, name, Number(index), field, input.value);
        persist();
        if (dateKey(parsedDate) === dateKey(viewedDate)) {
          $("#swap-select").disabled = true;
          $("#swap-apply").disabled = true;
          $("#swap-hint").textContent = "Ya has anotado datos este día, así que no se puede cambiar la rutina planificada.";
        }
      });
    });
    $$(".progress-button").forEach(button => button.addEventListener("click", () => openProgress(button.dataset.name)));
  }

  function applySwap() {
    if (!requireEditing()) return;
    if (isDayCompleted(viewedDate) || isDayLocked(viewedDate)) { showToast("Ya has anotado datos este día; no se puede cambiar la rutina planificada."); return; }
    const weekday = Number($("#swap-select").value);
    touch(viewedDate);
    currentOverrides()[dateKey(viewedDate)] = DEFAULT_TEMPLATE[weekday].map(item => ({ ...item, day: weekday }));
    renderRoutine();
    persist();
    showToast("Rutina intercambiada para este día. Pulsa Guardar para conservarlo.");
  }

  function resetSwap() {
    if (!requireEditing() || isDayLocked(viewedDate)) return;
    touch(viewedDate);
    delete currentOverrides()[dateKey(viewedDate)];
    renderRoutine();
    persist();
    showToast("Se restableció la rutina por defecto para este día.");
  }

  // ---------- Ejercicios ----------

  function renderMuscleTabs() {
    const container = $("#muscle-tabs");
    container.innerHTML = MUSCLES.map(muscle => `<button type="button" class="muscle-tab${muscle === activeMuscle ? " active" : ""}" data-muscle="${muscle}" role="tab" aria-selected="${muscle === activeMuscle}">${MUSCLE_LABELS[muscle]}</button>`).join("");
    $$(".muscle-tab").forEach(button => button.addEventListener("click", () => {
      activeMuscle = button.dataset.muscle;
      resetExerciseForm();
      renderExercises();
    }));
  }

  function exerciseById(muscle, exerciseId) { return (state.exercises[muscle] || []).find(exercise => exercise.id === exerciseId); }

  function renderExerciseList() {
    const list = $("#exercise-list");
    const exercises = (state.exercises[activeMuscle] || []).slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, "es"));
    $("#exercise-list-title").textContent = `Ejercicios · ${MUSCLE_LABELS[activeMuscle]}`;
    $("#exercise-summary").textContent = `${exercises.length} guardados · ${exercises.filter(exercise => exercise.active).length} activos en la rutina`;
    list.innerHTML = "";
    if (!exercises.length) { list.innerHTML = `<div class="empty-state"><strong>Aún no hay ejercicios para ${MUSCLE_LABELS[activeMuscle]}</strong>Añade el primero con el formulario.</div>`; return; }
    exercises.forEach(exercise => {
      const card = document.createElement("article");
      card.className = `exercise-item${exercise.active ? "" : " inactive"}`;
      card.innerHTML = `<div class="exercise-item-info"><div class="exercise-item-title">${escapeHtml(exercise.name)}${exercise.active ? "" : " <span class=\"inactive-badge\">Inactivo</span>"}</div><p class="exercise-item-meta">${exercise.sets} series × ${exercise.reps} repeticiones</p>${exercise.comment ? `<p class="exercise-item-comment">${escapeHtml(exercise.comment)}</p>` : ""}${exercise.active ? dayChipsHtml(exercise) : ""}</div><div class="card-actions"><button class="mini-button exercise-toggle" type="button" data-id="${escapeHtml(exercise.id)}">${exercise.active ? "Desactivar" : "Activar"}</button><button class="mini-button exercise-edit" type="button" data-id="${escapeHtml(exercise.id)}" aria-label="Editar ${escapeHtml(exercise.name)}">Editar</button><button class="mini-button exercise-delete" type="button" data-id="${escapeHtml(exercise.id)}" aria-label="Eliminar ${escapeHtml(exercise.name)}">×</button></div>`;
      list.append(card);
    });
    $$(".day-chip").forEach(button => button.addEventListener("click", () => toggleExerciseDay(button.dataset.id, Number(button.dataset.day))));
    $$(".exercise-toggle").forEach(button => button.addEventListener("click", () => toggleExercise(button.dataset.id)));
    $$(".exercise-edit").forEach(button => button.addEventListener("click", () => editExercise(button.dataset.id)));
    $$(".exercise-delete").forEach(button => button.addEventListener("click", () => deleteExercise(button.dataset.id)));
    enableEditing(canEdit());
  }

  function resetExerciseForm() {
    $("#exercise-form").reset();
    $("#exercise-id").value = "";
    $("#exercise-sets").value = "3";
    $("#exercise-reps").value = "10";
    $("#exercise-form-heading").textContent = "Añadir ejercicio";
    $("#save-exercise").textContent = "Guardar ejercicio";
    $("#cancel-exercise-edit").hidden = true;
  }

  function editExercise(exerciseId) {
    if (!requireEditing()) return;
    const exercise = exerciseById(activeMuscle, exerciseId);
    if (!exercise) return;
    $("#exercise-id").value = exercise.id;
    $("#exercise-name").value = exercise.name;
    $("#exercise-sets").value = exercise.sets;
    $("#exercise-reps").value = exercise.reps;
    $("#exercise-comment").value = exercise.comment;
    $("#exercise-form-heading").textContent = "Editar ejercicio";
    $("#save-exercise").textContent = "Guardar cambios";
    $("#cancel-exercise-edit").hidden = false;
    $("#exercise-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function dayChipsHtml(exercise) {
    const days = trainingDaysFor(activeMuscle);
    if (!days.length) return "";
    const chips = days.map(day => `<button type="button" class="day-chip${exerciseAppliesToDay(exercise, day) ? " on" : ""}" data-id="${escapeHtml(exercise.id)}" data-day="${day}" aria-pressed="${exerciseAppliesToDay(exercise, day)}">${WEEKDAY_FULL[day].slice(0, 3)}</button>`).join("");
    return `<div class="day-chips"><span class="muted-small">Días:</span>${chips}</div>`;
  }

  function toggleExerciseDay(exerciseId, day) {
    if (!requireEditing()) return;
    const exercise = exerciseById(activeMuscle, exerciseId);
    if (!exercise) return;
    const all = trainingDaysFor(activeMuscle);
    const current = exercise.days ? exercise.days.filter(value => all.includes(value)) : all.slice();
    const next = current.includes(day) ? current.filter(value => value !== day) : [...current, day];
    exercise.days = next.length === all.length ? null : next;
    renderExercises();
    renderRoutine();
    persist();
  }

  function renderDaySummary() {
    const box = $("#day-summary");
    const rows = [1, 2, 3, 4, 5].map(day => {
      const parts = DEFAULT_TEMPLATE[day].map(item => {
        const count = (state.exercises[item.muscle] || []).filter(exercise => exercise.active && exerciseAppliesToDay(exercise, day)).length;
        return `${MUSCLE_LABELS[item.muscle]} ${count}`;
      });
      return `<li><strong>${WEEKDAY_FULL[day][0].toUpperCase()}${WEEKDAY_FULL[day].slice(1)}:</strong> ${parts.join(" · ")}</li>`;
    });
    box.innerHTML = `<strong>Ejercicios por día</strong><ul>${rows.join("")}</ul>`;
  }

  function toggleExercise(exerciseId) {
    if (!requireEditing()) return;
    const exercise = exerciseById(activeMuscle, exerciseId);
    if (!exercise) return;
    exercise.active = !exercise.active;
    renderExercises();
    renderRoutine();
    persist();
    showToast(exercise.active ? "Ejercicio activado en la rutina." : "Ejercicio desactivado; su histórico se conserva.");
  }

  async function deleteExercise(exerciseId) {
    if (!requireEditing()) return;
    const exercise = exerciseById(activeMuscle, exerciseId);
    if (!exercise || !confirm(`¿Eliminar «${exercise.name}»? Mejor desactívalo si quieres volver a usarlo. No afectará a los datos ya registrados en días anteriores.`)) return;
    deletedExerciseIds.add(exerciseId);
    state.exercises[activeMuscle] = state.exercises[activeMuscle].filter(item => item.id !== exerciseId);
    renderExercises();
    renderRoutine();
    await persist();
    showToast("Ejercicio eliminado.");
  }

  async function onExerciseSubmit(event) {
    event.preventDefault();
    if (!requireEditing()) return;
    const name = $("#exercise-name").value.trim();
    const sets = Math.max(1, Math.round(Number($("#exercise-sets").value) || 0));
    const reps = Math.max(1, Math.round(Number($("#exercise-reps").value) || 0));
    const comment = $("#exercise-comment").value.trim();
    if (!name) { $("#exercise-name").focus(); return; }
    const editingId = $("#exercise-id").value;
    const duplicate = state.exercises[activeMuscle].find(exercise => normalizeText(exercise.name) === normalizeText(name) && exercise.id !== editingId);
    if (duplicate) { showToast("Ya existe un ejercicio con ese nombre en este grupo muscular."); return; }
    const previous = editingId ? exerciseById(activeMuscle, editingId) : null;
    const exercise = { id: editingId || id(), name, sets, reps, comment, active: previous ? previous.active : true, days: previous ? previous.days : null };
    const index = state.exercises[activeMuscle].findIndex(item => item.id === exercise.id);
    if (index >= 0) state.exercises[activeMuscle][index] = exercise;
    else state.exercises[activeMuscle].push(exercise);
    resetExerciseForm();
    renderExercises();
    renderRoutine();
    await persist();
    showToast(index >= 0 ? "Ejercicio actualizado. Pulsa Guardar para conservarlo." : "Ejercicio añadido. Pulsa Guardar para conservarlo.");
  }

  function renderExercises() { renderMuscleTabs(); renderExerciseList(); renderDaySummary(); }

  function renderAll() { renderPersonTabs(); renderRoutine(); renderExercises(); enableEditing(canEdit()); }

  function init() {
    restoreLocalCache();
    fillSwapSelect();
    renderPersonTabs();
    $$(".tab").forEach(tab => tab.addEventListener("click", () => switchPanel(tab.dataset.panel)));
    $("#connect-button").addEventListener("click", () => connected() ? disconnect() : connect());
    $("#notice-connect").addEventListener("click", () => connect());
    $("#demo-button").addEventListener("click", startDemo);
    $("#save-button").addEventListener("click", saveChanges);
    $("#progress-dialog-close").addEventListener("click", () => $("#progress-dialog").close());
    $("#progress-dialog").addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); });

    $("#previous-day").addEventListener("click", () => { viewedDate = plusDays(viewedDate, -1); renderRoutine(); });
    $("#next-day").addEventListener("click", () => { viewedDate = plusDays(viewedDate, 1); renderRoutine(); });
    $("#current-day").addEventListener("click", () => { viewedDate = todayAtMidnight(); renderRoutine(); });
    $("#swap-apply").addEventListener("click", applySwap);
    $("#swap-reset").addEventListener("click", resetSwap);

    $("#exercise-form").addEventListener("submit", onExerciseSubmit);
    $("#cancel-exercise-edit").addEventListener("click", resetExerciseForm);

    resetExerciseForm();
    try { if (localStorage.getItem(DEMO_STORAGE_KEY)) $("#demo-button").textContent = "Continuar prueba local"; } catch { /* almacenamiento no disponible */ }

    renderAll();
    enableEditing(localCacheReady);
    setStatus(localCacheReady ? dirty ? "Borrador local recuperado" : "Datos locales disponibles" : "Conectando con Drive…", localCacheReady ? "" : "busy");
    setInterval(writeLocalCache, 30000);
    setInterval(() => { if (connected() && dirty && !saving) saveChanges({ quiet: true, automatic: true }); }, 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        writeLocalCache();
        if (connected() && dirty && !saving) saveChanges({ quiet: true, automatic: true });
      }
    });

    window.addEventListener("beforeunload", event => {
      writeLocalCache();
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });

    // Intento de conexión automática y silenciosa con Google Drive al abrir la app.
    // Si no hay sesión/consentimiento previo, no se muestra ningún popup: se
    // ofrece el botón de conexión manual y el modo de prueba como alternativa.
    (async () => {
      try {
        const data = await window.gymDrive.trySilentSignIn();
        if (data) {
          onConnected(data);
          showToast("Conectado a Google Drive automáticamente.");
        } else {
          setStatus(localCacheReady ? dirty ? "Borrador local pendiente de Drive" : "Sin conexión · disponible en local" : "No conectado");
          $("#connection-notice").classList.add("visible");
          enableEditing(localCacheReady);
        }
      } catch (error) {
        console.warn("No se pudo conectar automáticamente con Drive", error);
        setStatus(localCacheReady ? dirty ? "Borrador local pendiente de Drive" : "Sin conexión · disponible en local" : "No conectado");
        $("#connection-notice").classList.add("visible");
        enableEditing(localCacheReady);
      }
    })();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
