# Simios Poderosos

Aplicación web adaptable a móviles para llevar la rutina semanal de gimnasio: qué ejercicios tocan cada día, y el peso y las repeticiones movidos en cada serie, comparando con la sesión anterior anotada para ese ejercicio. Los datos se guardan en Google Drive con autenticación OAuth en el navegador y un JSON principal, igual que en [PROGRAMA_WEB_COMIDAS](../PROGRAMA_WEB_COMIDAS).

## Guardado en Drive

- Cuenta: la misma cuenta de Google que usan el resto de programas web de esta carpeta.
- Carpeta: `PROGRAMA_WEB_GYM`.
- Folder ID configurado: `1FTSO3K_Bj3cXoSZVE-FzvLAHqRSpXasz`.
- Datos: `gym_rutina_db.json`.
- Copias: se crea una copia de seguridad al terminar un día; se conservan las cinco más recientes.
- **Conexión automática:** al abrir la app intenta conectar con Drive sin mostrar ninguna ventana, reutilizando la sesión/consentimiento de Google que ya tengas concedido en este navegador. Si no es posible (primera vez, sesión caducada, navegador bloqueando el acceso silencioso…) aparece el aviso para conectar manualmente o para «Probar sin Drive».
- Cada cambio se guarda primero en el almacenamiento local del navegador (debounce de 250 ms y respaldo periódico cada 30 segundos). Si Drive está conectado, se sincroniza también automáticamente cada 30 segundos; **Guardar** fuerza una sincronización inmediata y **Día terminado** sincroniza el bloqueo y programa una copia de seguridad.
- Si Drive no responde, se conserva el borrador local y la app permite seguir registrando el entrenamiento. Al recuperar/conectar Drive, los cambios pendientes se fusionan antes de subirlos. El estado muestra cuándo los datos están pendientes de sincronización.
- La sincronización vuelve a leer el archivo de Drive antes de fusionar y subir, evitando que el guardado de una persona sustituya normalmente los datos de la otra. Si ambos editan exactamente el mismo día/persona al mismo tiempo, debe prevalecer una sola persona editora para evitar conflictos.

## Requisitos de Google OAuth

Usa el mismo Client ID web que el resto de programas de esta carpeta. En Google Cloud deben estar habilitados Google Drive API, la pantalla de consentimiento y el origen web desde el que se publique/abra la app (`http://localhost:5513` para pruebas en local). La cuenta de Google que autorice debe tener acceso a la carpeta `PROGRAMA_WEB_GYM` en Drive.

## Ejecutar en local

Desde esta carpeta, inicia un servidor estático con Python:

```powershell
python -m http.server 5513
```

Abre `http://localhost:5513/` en el navegador. No abras `index.html` directamente como archivo: OAuth necesita un origen HTTP/HTTPS.

## Uso

1. Al abrir la app, intenta conectar con Drive automáticamente. Si no puede, pulsa **Conectar Drive** o **Probar sin Drive** (los datos de prueba se guardan solo en este navegador).
2. **Pestaña Ejercicios:** elige uno de los 6 grupos musculares (Pecho, Bíceps, Espalda, Tríceps, Hombro, Pierna) y añade cada máquina o ejercicio con su nombre, número de series, número de repeticiones y un comentario opcional (agarre, ajuste de máquina, etc.).
3. **Pestaña Rutina:** muestra automáticamente, según el día del calendario en curso, los ejercicios que tocan ese día:
   - Lunes: Espalda (fuerte) + Bíceps (normal)
   - Martes: Pecho (fuerte) + Tríceps (normal)
   - Miércoles: Pierna (normal) + Hombro (fuerte)
   - Jueves: Espalda (normal) + Bíceps (normal)
   - Viernes: Pecho (normal) + Hombro (normal) + Tríceps (suave)
   - Sábado y domingo: descanso

   Puedes moverte a un día anterior o posterior con las flechas, y volver a hoy con **Ir a hoy**. Si un día aún no tiene ninguna serie registrada, puedes **intercambiar su rutina planificada** por la de otro día de la semana con el selector y el botón **Intercambiar** (y deshacerlo con **Quitar cambio**). En cuanto anotas algún dato ese día, el intercambio se bloquea para no perder lo ya registrado.
4. Para cada ejercicio del día, anota en cada serie el peso movido (kg) y las repeticiones. La aplicación conserva el borrador local al instante y sincroniza los cambios pendientes con Drive automáticamente cada 30 segundos. **Guardar** fuerza la sincronización inmediata.
5. Pulsa **Progreso** en una tarjeta para ver el historial de ese ejercicio para la persona seleccionada: estimación deportiva de 1RM, peso máximo y volumen total por sesión.

Eliminar un ejercicio de la pestaña Ejercicios no borra los datos ya registrados en días anteriores; simplemente deja de mostrarse en la planificación de nuevos días.

## Publicación

El workflow `.github/workflows/pages.yml` publica la app en GitHub Pages en cada push a `main`: `https://swimpiii.github.io/PROGRAMA_WEB_GYM/`. Requiere **Settings → Pages → Source: GitHub Actions**. El origen `https://swimpiii.github.io` ya está autorizado en el cliente OAuth de Google compartido con el resto de programas.

## Ejercicios activos y días terminados

- En la pestaña Ejercicios puedes guardar todos los ejercicios que quieras y **activarlos/desactivarlos**: solo los activos aparecen en la rutina. Los inactivos conservan su histórico.
- El botón **Día terminado** bloquea ese día (por persona) y ya no se puede modificar ni intercambiar.

## Ejercicios por día

Cada ejercicio activo muestra chips con los días de la semana en que toca su grupo muscular (p. ej. Espalda: lun y jue). Marca o desmarca los días para decidir en cuáles aparece; así puedes tener 4 ejercicios de espalda el lunes y 3 el jueves. Un cuadro resumen indica cuántos ejercicios hay por grupo y día. Por defecto, un ejercicio aparece en todos sus días.

## Uso simultáneo (Ismael y David)

Al pulsar **Guardar**, la app vuelve a leer Drive y fusiona: solo sobrescribe los días que tú has tocado en tu pestaña; los datos de la otra persona y los ejercicios añadidos por ella se conservan. Un día bloqueado con **Día terminado** en Drive nunca se sobrescribe. Para compartir la carpeta de Drive con otra cuenta, compártela desde Drive como Editor y, si la app OAuth está en modo *Testing*, añade esa cuenta como usuario de prueba en Google Cloud (Pantalla de consentimiento).

## Progreso deportivo

Cada ejercicio de la rutina tiene un botón **Progreso**, con un gráfico para la persona seleccionada. Puedes comparar el 1RM estimado (fórmula de Epley, solo series de hasta 12 repeticiones), el peso máximo y el volumen total de cada sesión (kg × repeticiones). Incluye una tabla de las últimas sesiones registradas.
