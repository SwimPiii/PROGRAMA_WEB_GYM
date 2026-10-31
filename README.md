# Simios Poderosos

Aplicación web adaptable a móviles para llevar la rutina semanal de gimnasio: qué ejercicios tocan cada día, y el peso y las repeticiones movidos en cada serie, comparando siempre con la última vez que se hizo ese mismo ejercicio el mismo día de la semana. Los datos se guardan en Google Drive con autenticación OAuth en el navegador y un JSON principal, igual que en [PROGRAMA_WEB_COMIDAS](../PROGRAMA_WEB_COMIDAS).

## Guardado en Drive

- Cuenta: la misma cuenta de Google que usan el resto de programas web de esta carpeta.
- Carpeta: `PROGRAMA_WEB_GYM`.
- Folder ID configurado: `1FTSO3K_Bj3cXoSZVE-FzvLAHqRSpXasz`.
- Datos: `gym_rutina_db.json`.
- Copias: guardadas en subcarpetas de año/mes, igual que en el programa de comidas, con cinco copias de seguridad más recientes en total.
- **Conexión automática:** al abrir la app intenta conectar con Drive sin mostrar ninguna ventana, reutilizando la sesión/consentimiento de Google que ya tengas concedido en este navegador. Si no es posible (primera vez, sesión caducada, navegador bloqueando el acceso silencioso…) aparece el aviso para conectar manualmente o para «Probar sin Drive».
- Los cambios quedan pendientes en memoria hasta pulsar **Guardar**. Al intentar cerrar la página con cambios pendientes, el navegador avisa de que se pueden perder. El modo de prueba persiste localmente solo al pulsar **Guardar**. No hay fusión de cambios simultáneos; si se usa en dos dispositivos a la vez, conviene recargar antes de editar desde el segundo.

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
4. Para cada ejercicio del día, anota en cada serie el peso movido (kg) y las repeticiones. Si ese mismo ejercicio (por nombre) se registró en una sesión anterior del mismo día de la semana, aparece primero el resultado conseguido entonces, para intentar superarlo.
5. Pulsa **Guardar** para subir los cambios a Drive (o guardarlos localmente en modo de prueba).

Eliminar un ejercicio de la pestaña Ejercicios no borra los datos ya registrados en días anteriores; simplemente deja de mostrarse en la planificación de nuevos días.

## Publicación

El workflow `.github/workflows/pages.yml` publica la app en GitHub Pages en cada push a `main`: `https://swimpiii.github.io/PROGRAMA_WEB_GYM/`. Requiere **Settings → Pages → Source: GitHub Actions**. El origen `https://swimpiii.github.io` ya está autorizado en el cliente OAuth de Google compartido con el resto de programas.
