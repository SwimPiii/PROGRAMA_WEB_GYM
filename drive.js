(function () {
  const cfg = window.GYM_CONFIG || {};
  const state = { initialized: false, signedIn: false, folderId: cfg.driveFolderId || null, folderVerified: false, fileId: null, lastError: null };
  let tokenClient = null;
  const BACKUP_SLOTS = 5;

  function waitFor(predicate, timeoutMs = 12000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (predicate()) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error("Los servicios de Google no se han cargado. Comprueba tu conexión e inténtalo de nuevo."));
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  async function init() {
    await waitFor(() => window.gapi && window.gapi.load && window.google && window.google.accounts && window.google.accounts.oauth2);
    await new Promise((resolve, reject) => window.gapi.load("client", async () => {
      try {
        await window.gapi.client.init({ discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] });
        state.initialized = true;
        resolve();
      } catch (error) { reject(error); }
    }));
    if (!cfg.googleClientId) throw new Error("Falta configurar el Client ID de Google en config.js.");
  }

  function quote(value) { return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

  async function resolveFolder() {
    if (state.folderId && state.folderVerified) return state.folderId;
    if (state.folderId) {
      try {
        const folder = await window.gapi.client.drive.files.get({ fileId: state.folderId, fields: "id,mimeType" });
        if (folder.result.mimeType === "application/vnd.google-apps.folder") {
          state.folderVerified = true;
          return state.folderId;
        }
      } catch (error) { state.lastError = error; }
    }
    const query = `name='${quote(cfg.driveFolderName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const result = await window.gapi.client.drive.files.list({ q: query, pageSize: 10, fields: "files(id,name)" });
    if (result.result.files && result.result.files.length) {
      state.folderId = result.result.files[0].id;
      state.folderVerified = true;
      return state.folderId;
    }
    const created = await window.gapi.client.drive.files.create({ resource: { name: cfg.driveFolderName, mimeType: "application/vnd.google-apps.folder" }, fields: "id" });
    state.folderId = created.result.id;
    state.folderVerified = true;
    return state.folderId;
  }

  function isUnauthorized(error) {
    return Number(error && (error.status || error.result && error.result.error && error.result.error.code)) === 401;
  }

  async function refreshAccessToken() {
    await init();
    const client = getTokenClient();
    return new Promise((resolve, reject) => {
      client.callback = response => {
        if (!response || !response.access_token) {
          state.signedIn = false;
          reject(new Error("La sesión de Google ha caducado. Pulsa «Conectar Drive» para volver a autorizar."));
          return;
        }
        window.gapi.client.setToken({ access_token: response.access_token });
        state.signedIn = true;
        resolve();
      };
      client.error_callback = error => {
        state.lastError = error;
        state.signedIn = false;
        reject(new Error("La sesión de Drive necesita autorización. Pulsa «Conectar Drive» para continuar."));
      };
      try { client.requestAccessToken({ prompt: "none", hint: cfg.googleAccountHint }); }
      catch (error) { reject(error); }
    });
  }

  async function withAuthRetry(operation) {
    try { return await operation(); }
    catch (error) {
      if (!isUnauthorized(error)) throw error;
      await refreshAccessToken();
      return operation();
    }
  }

  async function findFile(folderId, name) {
    const q = `name='${quote(name)}' and '${quote(folderId)}' in parents and trashed=false`;
    const response = await window.gapi.client.drive.files.list({ q, pageSize: 10, fields: "files(id,name)" });
    return response.result.files && response.result.files.length ? response.result.files[0] : null;
  }

  async function upload(fileId, content, name) {
    const boundary = "gym_boundary_2026";
    const delimiter = `\r\n--${boundary}\r\n`;
    const body = delimiter + "Content-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify({ name, mimeType: "application/json" }) + delimiter + "Content-Type: application/json\r\n\r\n" + content + `\r\n--${boundary}--`;
    return window.gapi.client.request({ path: `/upload/drive/v3/files/${fileId}`, method: "PATCH", params: { uploadType: "multipart" }, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  }

  async function createJson(folderId, name, content) {
    const file = await window.gapi.client.drive.files.create({ resource: { name, mimeType: "application/json", parents: [folderId] }, fields: "id" });
    await upload(file.result.id, content, name);
    return file.result.id;
  }

  function baseName() { return String(cfg.driveFileName).replace(/\.json$/i, ""); }
  function stamp(date) { return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_").replace("Z", ""); }
  function manifestName() { return `${baseName()}__backups_manifest.json`; }

  function emptyManifest() { return { nextSlot: 1, latestSlot: null, latestSavedAt: "", slots: {} }; }

  async function readManifest(folderId) {
    const file = await findFile(folderId, manifestName());
    if (!file) return { fileId: null, manifest: emptyManifest() };
    const result = await window.gapi.client.drive.files.get({ fileId: file.id, alt: "media" });
    if (!result.result || typeof result.result !== "object" || Array.isArray(result.result)) {
      throw new Error(`El manifiesto de backups ${manifestName()} no tiene un formato válido.`);
    }
    return { fileId: file.id, manifest: { ...emptyManifest(), ...result.result, slots: result.result.slots && typeof result.result.slots === "object" ? result.result.slots : {} } };
  }

  async function writeManifest(folderId, fileId, manifest) {
    const content = JSON.stringify(manifest);
    if (fileId) await upload(fileId, content, manifestName());
    else await createJson(folderId, manifestName(), content);
  }

  async function getOrCreateFolder(parentId, name) {
    const query = `name='${quote(name)}' and '${quote(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const response = await window.gapi.client.drive.files.list({ q: query, pageSize: 10, fields: "files(id,name)" });
    if (response.result.files && response.result.files.length) return response.result.files[0].id;
    const created = await window.gapi.client.drive.files.create({ resource: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }, fields: "id" });
    return created.result.id;
  }

  async function getBackupMonthFolder(rootFolderId, date) {
    const yearName = String(date.getFullYear());
    const monthName = String(date.getMonth() + 1).padStart(2, "0");
    const yearFolderId = await getOrCreateFolder(rootFolderId, yearName);
    return getOrCreateFolder(yearFolderId, monthName);
  }

  async function migrateRootBackups(rootFolderId) {
    const legacyFile = await findFile(rootFolderId, manifestName());
    if (!legacyFile) return;

    const { manifest: oldManifest } = await readManifest(rootFolderId);
    const entries = [];
    for (const [oldSlot, entry] of Object.entries(oldManifest.slots)) {
      if (!entry || !entry.fileId) continue;
      let file;
      try {
        const response = await window.gapi.client.drive.files.get({ fileId: entry.fileId, fields: "id,name,parents,modifiedTime" });
        file = response.result;
      } catch (error) {
        if (error.status === 404) continue;
        throw error;
      }

      let savedAt = entry.savedAt || "";
      if (!savedAt || Number.isNaN(new Date(savedAt).getTime())) {
        const backup = await window.gapi.client.drive.files.get({ fileId: file.id, alt: "media" });
        savedAt = backup.result && backup.result.backupMetadata && backup.result.backupMetadata.savedAt || file.modifiedTime || new Date().toISOString();
      }
      const savedDate = new Date(savedAt);
      const safeDate = Number.isNaN(savedDate.getTime()) ? new Date() : savedDate;
      entries.push({ oldSlot: Number(oldSlot), entry, file, savedAt, safeDate });
    }

    entries.sort((a, b) => a.safeDate - b.safeDate);
    const retained = entries.slice(-BACKUP_SLOTS);
    const removed = entries.slice(0, Math.max(0, entries.length - BACKUP_SLOTS));
    for (const backup of removed) {
      try { await window.gapi.client.drive.files.delete({ fileId: backup.file.id }); }
      catch (error) { if (error.status !== 404) throw error; }
    }

    const migratedSlots = {};
    for (let index = 0; index < retained.length; index++) {
      const backup = retained[index];
      const monthFolderId = await getBackupMonthFolder(rootFolderId, backup.safeDate);
      const parents = backup.file.parents || [];
      if (!parents.includes(monthFolderId)) {
        await window.gapi.client.drive.files.update({ fileId: backup.file.id, addParents: monthFolderId, removeParents: parents.join(","), fields: "id,parents" });
      }
      const slot = index + 1;
      migratedSlots[String(slot)] = { fileId: backup.file.id, fileName: backup.file.name || backup.entry.fileName, savedAt: backup.savedAt };
    }

    const latest = retained[retained.length - 1];
    const manifest = {
      nextSlot: retained.length < BACKUP_SLOTS ? retained.length + 1 : 1,
      latestSlot: latest ? retained.length : null,
      latestSavedAt: latest ? latest.savedAt : "",
      slots: migratedSlots
    };
    await writeManifest(rootFolderId, legacyFile.id, manifest);
  }

  async function saveBackup(payload, rootFolderId) {
    await migrateRootBackups(rootFolderId);
    const savedDate = new Date();
    const savedAt = savedDate.toISOString();
    const monthFolderId = await getBackupMonthFolder(rootFolderId, savedDate);
    const { fileId: manifestFileId, manifest } = await readManifest(rootFolderId);
    const slot = Number(manifest.nextSlot) >= 1 && Number(manifest.nextSlot) <= BACKUP_SLOTS ? Number(manifest.nextSlot) : 1;
    const old = manifest.slots[String(slot)];
    if (old && old.fileId) {
      try { await window.gapi.client.drive.files.delete({ fileId: old.fileId }); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    const fileName = `${baseName()}__backup_${String(slot).padStart(2, "0")}__${stamp(savedDate)}.json`;
    const backupId = await createJson(monthFolderId, fileName, JSON.stringify({ backupMetadata: { slot, savedAt, sourceFileName: cfg.driveFileName }, state: payload }));
    const updated = {
      nextSlot: slot === BACKUP_SLOTS ? 1 : slot + 1,
      latestSlot: slot,
      latestSavedAt: savedAt,
      slots: { ...manifest.slots, [String(slot)]: { fileId: backupId, fileName, savedAt } }
    };
    await writeManifest(rootFolderId, manifestFileId, updated);
  }

  function getTokenClient() {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: cfg.googleClientId, scope: cfg.googleScopes, hint: cfg.googleAccountHint, callback: "", error_callback: error => { state.lastError = error; } });
    }
    return tokenClient;
  }

  async function afterTokenObtained() {
    state.signedIn = true;
    const folderId = await resolveFolder();
    const dataFile = await findFile(folderId, cfg.driveFileName);
    state.fileId = dataFile ? dataFile.id : null;
    return load();
  }

  async function signIn() {
    await init();
    const client = getTokenClient();
    return new Promise((resolve, reject) => {
      client.callback = async response => {
        try {
          if (!response || !response.access_token) throw new Error("Google no devolvió un token de acceso.");
          window.gapi.client.setToken({ access_token: response.access_token });
          const data = await afterTokenObtained();
          resolve(data);
        } catch (error) { state.lastError = error; state.signedIn = false; reject(error); }
      };
      try { client.requestAccessToken({ prompt: "", hint: cfg.googleAccountHint }); }
      catch (error) { reject(error); }
    });
  }

  // Intenta conectar automáticamente sin mostrar ninguna ventana emergente,
  // reutilizando la sesión/consentimiento previo de Google si existe.
  // Si no es posible (primera vez, sesión caducada, navegador bloqueando el
  // iframe silencioso, etc.) se resuelve con null y la app debe mostrar el
  // botón de conexión manual como alternativa.
  async function trySilentSignIn() {
    try {
      await init();
      const client = getTokenClient();
      return await new Promise(resolve => {
        client.callback = async response => {
          try {
            if (!response || !response.access_token) { resolve(null); return; }
            window.gapi.client.setToken({ access_token: response.access_token });
            const data = await afterTokenObtained();
            resolve(data);
          } catch (error) { state.lastError = error; state.signedIn = false; resolve(null); }
        };
        client.error_callback = error => { state.lastError = error; resolve(null); };
        try { client.requestAccessToken({ prompt: "none", hint: cfg.googleAccountHint }); }
        catch (error) { state.lastError = error; resolve(null); }
      });
    } catch (error) {
      state.lastError = error;
      return null;
    }
  }

  async function load() {
    if (!state.signedIn) throw new Error("Conecta con Google Drive para cargar los datos.");
    return withAuthRetry(async () => {
      if (!state.fileId) {
        const existing = await findFile(await resolveFolder(), cfg.driveFileName);
        state.fileId = existing ? existing.id : null;
      }
      if (!state.fileId) return { version: 1, exercises: {}, overrides: {}, sessions: {}, lastUpdated: null };
      const response = await window.gapi.client.drive.files.get({ fileId: state.fileId, alt: "media" });
      const data = response.result;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("El archivo de datos de Drive no tiene un formato válido.");
      return data;
    });
  }

  async function save(payload) {
    if (!state.signedIn) throw new Error("Conecta con Google Drive antes de guardar.");
    return withAuthRetry(async () => {
      const folderId = await resolveFolder();
      if (!state.fileId) {
        const existing = await findFile(folderId, cfg.driveFileName);
        state.fileId = existing ? existing.id : null;
        if (!state.fileId) state.fileId = await createJson(folderId, cfg.driveFileName, JSON.stringify(payload));
        else await upload(state.fileId, JSON.stringify(payload), cfg.driveFileName);
      } else {
        await upload(state.fileId, JSON.stringify(payload), cfg.driveFileName);
      }
    });
  }

  async function createBackup(payload) {
    if (!state.signedIn) throw new Error("Conecta con Google Drive para crear la copia.");
    await withAuthRetry(async () => {
      const folderId = await resolveFolder();
      await saveBackup(payload, folderId);
    });
  }

  async function signOut() {
    try {
      const token = window.gapi.client.getToken();
      if (token && token.access_token) await new Promise(resolve => window.google.accounts.oauth2.revoke(token.access_token, resolve));
    } finally {
      if (window.gapi && window.gapi.client) window.gapi.client.setToken("");
      state.signedIn = false;
      state.fileId = null;
    }
  }

  window.gymDrive = { signIn, trySilentSignIn, signOut, load, save, saveBackup: createBackup, isSignedIn: () => state.signedIn, getDebugInfo: () => ({ folderId: state.folderId, fileId: state.fileId, lastError: state.lastError }) };
})();
