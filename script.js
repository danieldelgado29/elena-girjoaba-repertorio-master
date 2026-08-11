"use strict";

// Página pública independiente: siempre muestra el repertorio Master completo.
const CATALOGO_PUBLICO = true;

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const MODOS = Object.freeze([
  { id: "principal-diario", nombre: "Principal diario" },
  { id: "solo-ingles", nombre: "Solo inglés" },
  { id: "principal-privados", nombre: "Principal privados" },
  { id: "eventos-corporativos", nombre: "Eventos corporativos" },
  { id: "tree-house", nombre: "Tree House" },
  { id: "tranquilas-principal", nombre: "Canciones tranquilas · Principal" },
  { id: "tranquilas-todas", nombre: "Canciones tranquilas · Todas + Jazz y Blues" },
  { id: "todas", nombre: "Todas las canciones" },
  { id: "solo-espanol", nombre: "Solo español" }
]);

const CONFIG = Object.freeze({
  claveAdmin: "2907",
  duracionPulsacionAdmin: 3000,
  rutaCanciones: "canciones.json?v=5",
  rutaConfiguracion: "configuracion.json",
  instagramApp: "instagram://user?username=elenagirjoabamusic",
  instagramWeb: "https://instagram.com/elenagirjoabamusic",
  telefonoWhatsApp: "593987388915",
  telefonoElena: "593987388915",
  telefonoDaniel: "593992890540",
  claveInstagramVisitado: "egmInstagramVisitado",
  claveInstagramDesbloqueo: "egmInstagramDesbloqueo",
  demoraContinuacionInstagram: 3000,
  rutaAnotaciones: "assets/anotaciones",
  rutaIndiceAnotaciones: "assets/anotaciones/index.json",
  extensionesAnotaciones: ["jpg", "jpeg", "png", "webp"]
});

function obtenerSeguridadLocal() {
  try {
    return {
      password: CONFIG.claveAdmin,
      danielPhone: CONFIG.telefonoDaniel,
      elenaPhone: CONFIG.telefonoElena,
      ...JSON.parse(localStorage.getItem("egm-security-settings") || "{}")
    };
  } catch (_) {
    return { password: CONFIG.claveAdmin, danielPhone: CONFIG.telefonoDaniel, elenaPhone: CONFIG.telefonoElena };
  }
}
function telefonoWhatsAppActual() {
  return String(obtenerSeguridadLocal().elenaPhone || CONFIG.telefonoWhatsApp).replace(/\D/g, "");
}

const estado = {
  todas: [],
  todasLocalesBase: [],
  base: [],
  visibles: [],
  modo: "principal-diario",
  modoForzado: false,
  repertoriosRemotos: new Set(),
  idsRepertorioRemoto: null,
  vistaClientes: false,
  categoria: null,
  consulta: "",
  mostrar: false,
  configRemota: {
    lista_activa: "principal-diario",
    pedidos_whatsapp: false,
    mostrar_cola: true,
    inicio_show: 0,
    cola: [],
    tocadas: [],
    lugar: "",
    perfil_clientes: "medio",
    show_activo: false
  },
  firebase: null,
  db: null,
  estadoRef: null,
  duracionShowMs: 8 * 60 * 60 * 1000,
  temporizadorAdmin: null,
  pedidoSeleccionado: null,
  reinicioEnCurso: false,
  contactos: [],
  filtroContactos: "show",
  anotacionesCache: new Map(),
  indiceAnotaciones: {},
  indiceAnotacionesCargado: false,
  letras: {},
  letraActualId: null,
  letraModoPanel: false,
  temporizadorEditarLetra: null,
  letraOriginalEdicion: "",
  confirmarResolver: null,
  agregarLetraTipo: null,
  nuevaCancionAbierta: false,
  cancionGritaActivaId: null,
  firmaEstadoRemoto: ""
};

const DOM = {};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function normalizar(valor = "") {
  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " y ")
    .replace(/[’'`´]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function depurarCanciones(canciones = []) {
  const unicas = new Map();

  canciones.forEach((cancion) => {
    const clave = `${normalizar(cancion.titulo)}::${normalizar(cancion.artista)}`;
    const categorias = [...new Set((cancion.categorias || ["Otros"]).filter(Boolean))];
    const listas = [...new Set((cancion.listas || ["todas"]).filter(Boolean))];

    if (!unicas.has(clave)) {
      unicas.set(clave, {
        ...cancion,
        categorias: categorias.length ? categorias : ["Otros"],
        listas: listas.includes("todas") ? listas : [...listas, "todas"]
      });
      return;
    }

    const existente = unicas.get(clave);
    existente.categorias = [...new Set([...existente.categorias, ...categorias])];
    existente.listas = [...new Set([...existente.listas, ...listas, "todas"])];
    existente.tranquila = Boolean(existente.tranquila || cancion.tranquila);
  });

  return [...unicas.values()];
}

function escapar(valor = "") {
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function esMovil() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function modoValido(id) {
  if (!id) return false;
  return MODOS.some((modo) => modo.id === id) ||
    estado.repertoriosRemotos.has(id) ||
    estado.todas.some((cancion) => Array.isArray(cancion.listas) && cancion.listas.includes(id));
}

function aplicarBibliotecaRemota(biblioteca) {
  if (!biblioteca || typeof biblioteca !== "object") return false;

  if (!estado.todasLocalesBase.length) {
    estado.todasLocalesBase = estado.todas.map((cancion) => ({ ...cancion }));
  }

  const ediciones = biblioteca.songEdits && typeof biblioteca.songEdits === "object"
    ? biblioteca.songEdits
    : {};
  const personalizadas = Array.isArray(biblioteca.customSongs)
    ? biblioteca.customSongs
    : [];

  estado.repertoriosRemotos = new Set(
    Array.isArray(biblioteca.customRepertoires)
      ? biblioteca.customRepertoires.map((r) => r && r.id).filter(Boolean)
      : []
  );

  const anteriores = JSON.stringify(estado.todas.map((c) => [c.id, c.titulo, c.artista, c.listas]));
  const combinadas = estado.todasLocalesBase.map((cancion) =>
    ediciones[cancion.id] ? { ...cancion, ...ediciones[cancion.id] } : { ...cancion }
  );

  const ids = new Set(combinadas.map((cancion) => cancion.id));
  personalizadas.forEach((cancion) => {
    if (!cancion || !cancion.id) return;
    const preparada = ediciones[cancion.id] ? { ...cancion, ...ediciones[cancion.id] } : { ...cancion };
    const indice = combinadas.findIndex((item) => item.id === preparada.id);
    if (indice >= 0) combinadas[indice] = preparada;
    else if (!ids.has(preparada.id)) {
      combinadas.push(preparada);
      ids.add(preparada.id);
    }
  });

  estado.todas = depurarCanciones(combinadas);
  estado.todas.sort((a, b) => a.titulo.localeCompare(b.titulo, "es", { sensitivity: "base" }));
  const actuales = JSON.stringify(estado.todas.map((c) => [c.id, c.titulo, c.artista, c.listas]));
  return anteriores !== actuales;
}

function nombreModo(id) {
  return MODOS.find((modo) => modo.id === id)?.nombre || id;
}

function obtenerCancion(id) {
  return estado.todas.find((cancion) => cancion.id === id) || null;
}


async function cargarLetras() {
  try {
    const respuesta = await fetch("data/letras.json?v=1", { cache: "no-store" });
    if (!respuesta.ok) throw new Error("No se pudieron cargar las letras.");
    estado.letras = await respuesta.json();

    Object.keys(estado.letras).forEach((id) => {
      const guardada = localStorage.getItem(`egmLetraEscenario:${id}`);
      if (guardada) estado.letras[id].escenarioHtml = guardada;
    });

    const letrasLocales = JSON.parse(localStorage.getItem("egmLetrasLocales") || "{}");
    estado.letras = { ...estado.letras, ...letrasLocales };
  } catch (error) {
    console.warn(error);
    estado.letras = {};
  }
}

function documentoLetraCliente(cancion) {
  if (!cancion) return null;
  const existente = estado.letras[cancion.id];
  if (existente) return existente;

  const texto = String(cancion.letraPublica || "").trim();
  if (!texto) return null;

  const html = texto.includes("<") ? texto : textoAHtmlLetra(texto);
  return {
    titulo: cancion.titulo,
    artista: cancion.artista,
    publicaHtml: html,
    escenarioHtml: html
  };
}

function tieneLetra(idCancion) {
  return Boolean(documentoLetraCliente(obtenerCancion(idCancion)));
}

function ocultarMenusLetra() {
  [DOM.letraColorMenu, DOM.letraTamanoMenu, DOM.letraIconosMenu].forEach((menu) => {
    if (!menu) return;
    menu.hidden = true;
    menu.classList.remove("is-open");
  });
  [DOM.letraColorBoton, DOM.letraTamanoBoton, DOM.letraIconosBoton].forEach((boton) => {
    boton?.setAttribute("aria-expanded", "false");
  });
}

function posicionarMenuLetra(menu, boton) {
  if (!menu || !boton) return;

  // En teléfono se conserva el menú tipo bandeja inferior.
  if (window.matchMedia("(max-width: 720px)").matches) {
    menu.style.removeProperty("top");
    menu.style.removeProperty("left");
    menu.style.removeProperty("right");
    menu.style.removeProperty("bottom");
    return;
  }

  // En escritorio usamos posición fija para que el menú no quede recortado
  // por el contenedor del cancionero cuando la ventana está maximizada.
  const rect = boton.getBoundingClientRect();
  const margen = 12;
  const anchoEstimado = menu.classList.contains("letra-toolbar__menu--iconos") ? 300 : 200;
  const izquierda = Math.min(
    Math.max(margen, rect.left),
    Math.max(margen, window.innerWidth - anchoEstimado - margen)
  );

  menu.style.position = "fixed";
  menu.style.left = `${izquierda}px`;
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 260)}px`;
}

function alternarMenuLetra(menu, boton) {
  if (!menu || !boton) return;
  const abrir = !menu.classList.contains("is-open");
  ocultarMenusLetra();
  if (abrir) {
    menu.hidden = false;
    menu.classList.add("is-open");
    posicionarMenuLetra(menu, boton);
  }
  boton.setAttribute("aria-expanded", String(abrir));
}

function confirmarAplicacion({ titulo, mensaje, confirmar = "Aceptar", cancelar = "Cancelar", peligro = false }) {
  return new Promise((resolve) => {
    if (!DOM.confirmacionModal) {
      resolve(window.confirm(mensaje));
      return;
    }
    DOM.confirmacionTitulo.textContent = titulo;
    DOM.confirmacionMensaje.textContent = mensaje;
    DOM.confirmacionAceptar.textContent = confirmar;
    DOM.confirmacionCancelar.textContent = cancelar;
    DOM.confirmacionAceptar.classList.toggle("confirmacion__aceptar--peligro", peligro);
    DOM.confirmacionModal.hidden = false;
    DOM.confirmacionAceptar.focus();
    estado.confirmarResolver = resolve;
  });
}

function resolverConfirmacion(valor) {
  if (!DOM.confirmacionModal || DOM.confirmacionModal.hidden) return;
  DOM.confirmacionModal.hidden = true;
  const resolver = estado.confirmarResolver;
  estado.confirmarResolver = null;
  resolver?.(valor);
}

async function cerrarLetra() {
  if (!DOM.letraModal) return;
  if (estado.letraModoPanel) {
    const aceptar = await confirmarAplicacion({
      titulo: "Cerrar cancionero",
      mensaje: "¿Seguro que deseas cerrar la letra?",
      confirmar: "Cerrar",
      cancelar: "Volver"
    });
    if (!aceptar) return;
  }

  DOM.letraModal.hidden = true;
  DOM.letraContenido.contentEditable = "false";
  DOM.letraToolbar.hidden = true;
  ocultarMenusLetra();
  DOM.letraEditar.hidden = !estado.letraModoPanel;
  document.body.classList.remove("modal-abierto");

  if (estado.letraModoPanel && DOM.adminModal && !DOM.adminModal.hidden) {
    DOM.adminModal.focus?.();
  }
}

function abrirLetra(cancion, modoPanel = false) {
  const documento = documentoLetraCliente(cancion);
  if (!documento || !DOM.letraModal) return;

  estado.letraActualId = cancion.id;
  estado.letraModoPanel = modoPanel;
  estado.letraOriginalEdicion = "";

  DOM.letraTitulo.textContent = documento.titulo || cancion.titulo;
  DOM.letraArtista.textContent = documento.artista || cancion.artista;
  DOM.letraContenido.innerHTML = modoPanel
    ? documento.escenarioHtml
    : documento.publicaHtml;

  DOM.letraContenido.contentEditable = "false";
  DOM.letraToolbar.hidden = true;
  ocultarMenusLetra();
  DOM.letraEditar.hidden = !modoPanel;
  DOM.letraModal.hidden = false;
  document.body.classList.add("modal-abierto");
  DOM.letraContenido.scrollTop = 0;
}

function activarEdicionLetra() {
  if (!estado.letraModoPanel || !DOM.letraContenido) return;
  estado.letraOriginalEdicion = DOM.letraContenido.innerHTML;
  DOM.letraContenido.contentEditable = "true";
  DOM.letraToolbar.hidden = false;
  DOM.letraEditar.hidden = true;
  DOM.letraContenido.focus();
}

async function guardarLetraEscenario() {
  const id = estado.letraActualId;
  if (!id || !estado.letras[id]) return;
  const aceptar = await confirmarAplicacion({
    titulo: "Guardar cambios",
    mensaje: "¿Seguro que deseas guardar los cambios?",
    confirmar: "Guardar",
    cancelar: "Seguir editando"
  });
  if (!aceptar) return;

  const contenido = DOM.letraContenido.innerHTML;
  estado.letras[id].escenarioHtml = contenido;
  localStorage.setItem(`egmLetraEscenario:${id}`, contenido);
  guardarLetrasLocales();
  estado.letraOriginalEdicion = "";
  DOM.letraContenido.contentEditable = "false";
  DOM.letraToolbar.hidden = true;
  ocultarMenusLetra();
  DOM.letraEditar.hidden = false;
  mostrarAviso("Cambios guardados exitosamente.");
}

function guardarLetrasLocales() {
  const locales = {};
  Object.entries(estado.letras).forEach(([id, doc]) => {
    if (doc.local) locales[id] = doc;
  });
  localStorage.setItem("egmLetrasLocales", JSON.stringify(locales));
}

function mostrarAviso(texto) {
  if (!DOM.avisoApp) return;
  DOM.avisoApp.textContent = texto;
  DOM.avisoApp.hidden = false;
  clearTimeout(DOM.avisoApp._timer);
  DOM.avisoApp._timer = setTimeout(() => { DOM.avisoApp.hidden = true; }, 2400);
}

async function cancelarEdicionLetra() {
  const id = estado.letraActualId;
  if (!id || !estado.letras[id]) return;
  const aceptar = await confirmarAplicacion({
    titulo: "Descartar cambios",
    mensaje: "¿Seguro que deseas descartar los cambios?",
    confirmar: "Descartar",
    cancelar: "Seguir editando",
    peligro: true
  });
  if (!aceptar) return;

  DOM.letraContenido.innerHTML = estado.letraOriginalEdicion || estado.letras[id].escenarioHtml;
  estado.letraOriginalEdicion = "";
  DOM.letraContenido.contentEditable = "false";
  DOM.letraToolbar.hidden = true;
  ocultarMenusLetra();
  DOM.letraEditar.hidden = false;
}

function ejecutarFormatoLetra(comando, valor = null) {
  DOM.letraContenido.focus();
  document.execCommand(comando, false, valor);
}

function insertarIconoLetra(icono) {
  ejecutarFormatoLetra("insertText", `${icono} `);
  ocultarMenusLetra();
}

function abrirMenuAgregarLetra() {
  if (!DOM.adminAgregarMenu) return;
  DOM.adminAgregarMenu.hidden = !DOM.adminAgregarMenu.hidden;
  if (DOM.adminAgregarLetra) DOM.adminAgregarLetra.setAttribute("aria-expanded", String(!DOM.adminAgregarMenu.hidden));
}

function poblarSelectorCancionesLetra() {
  if (!DOM.agregarLetraCancion) return;
  const canciones = [...estado.todas].sort((a, b) =>
    a.titulo.localeCompare(b.titulo, "es", { sensitivity: "base" })
  );
  DOM.agregarLetraCancion.innerHTML = '<option value="">Selecciona una canción…</option>' +
    canciones.map((cancion) => `<option value="${escapar(cancion.id)}">${escapar(cancion.titulo)} · ${escapar(cancion.artista)}</option>`).join("");
}

function seleccionarModoNuevaCancion(esNueva) {
  if (DOM.agregarLetraExistenteCampos) DOM.agregarLetraExistenteCampos.hidden = esNueva;
  if (DOM.agregarLetraNuevaCampos) DOM.agregarLetraNuevaCampos.hidden = !esNueva;
  if (DOM.agregarLetraModoExistente) DOM.agregarLetraModoExistente.classList.toggle("is-active", !esNueva);
  if (DOM.agregarLetraNuevaCancion) DOM.agregarLetraNuevaCancion.classList.toggle("is-active", esNueva);
  if (DOM.agregarLetraCancion) DOM.agregarLetraCancion.value = esNueva ? "__nueva__" : "";
  if (DOM.agregarLetraError) DOM.agregarLetraError.hidden = true;
  if (esNueva) setTimeout(() => DOM.agregarLetraNuevoTitulo?.focus(), 0);
}

function abrirAgregarLetra(tipo) {
  estado.agregarLetraTipo = tipo;
  DOM.adminAgregarMenu.hidden = true;
  if (DOM.adminAgregarLetra) DOM.adminAgregarLetra.setAttribute("aria-expanded", "false");
  poblarSelectorCancionesLetra();
  DOM.agregarLetraTitulo.textContent = tipo === "publica" ? "Crear letra para clientes" : "Crear letra para administradora";
  DOM.agregarLetraCancion.value = "";
  DOM.agregarLetraTexto.value = "";
  DOM.agregarLetraModal.hidden = false;
}

function cerrarAgregarLetra() {
  DOM.agregarLetraModal.hidden = true;
}

function textoAHtmlLetra(texto) {
  return texto.split(/\r?\n/).map((linea) => linea.trim() ? `<p>${escapar(linea)}</p>` : '<p><br></p>').join("");
}

function crearIdCancion(titulo) {
  const base = normalizar(titulo).replace(/\s+/g, "-") || `cancion-${Date.now()}`;
  let id = `local-${base}`;
  let n = 2;
  while (estado.todas.some((c) => c.id === id)) id = `local-${base}-${n++}`;
  return id;
}

function guardarCancionesLocales() {
  const locales = estado.todas.filter((c) => String(c.id).startsWith("local-"));
  localStorage.setItem("egmCancionesLocales", JSON.stringify(locales));
}

async function guardarNuevaLetra() {
  const valor = DOM.agregarLetraCancion.value;
  const texto = DOM.agregarLetraTexto.value.trim();
  if (!valor || !texto) {
    DOM.agregarLetraError.textContent = "Selecciona una canción y pega la letra.";
    DOM.agregarLetraError.hidden = false;
    return;
  }

  const cancion = obtenerCancion(valor);
  if (!cancion) return;

  const html = textoAHtmlLetra(texto);
  const existente = estado.letras[cancion.id] || {
    titulo: cancion.titulo, artista: cancion.artista, publicaHtml: html, escenarioHtml: html, local: true
  };
  existente.local = true;
  existente.titulo = cancion.titulo;
  existente.artista = cancion.artista;
  if (estado.agregarLetraTipo === "publica") {
    existente.publicaHtml = html;
    if (!existente.escenarioHtml) existente.escenarioHtml = html;
  } else {
    existente.escenarioHtml = html;
    if (!existente.publicaHtml) existente.publicaHtml = html;
  }
  estado.letras[cancion.id] = existente;
  guardarLetrasLocales();
  cerrarAgregarLetra();
  renderizarListaMaestra();
  renderizar();
  mostrarAviso("Letra guardada exitosamente.");
}

function poblarListasNuevaCancion() {
  if (!DOM.nuevaCancionListas) return;
  DOM.nuevaCancionListas.innerHTML = MODOS.filter((m) => m.id !== "todas").map((modo) => `
    <label class="nueva-cancion-lista">
      <input type="checkbox" value="${escapar(modo.id)}">
      <span>${escapar(modo.nombre)}</span>
    </label>`).join("") + `
    <label class="nueva-cancion-lista nueva-cancion-lista--fija">
      <input type="checkbox" value="todas" checked disabled>
      <span>Todas las canciones</span>
    </label>`;
}

function abrirNuevaCancion() {
  poblarListasNuevaCancion();
  DOM.nuevaCancionNombre.value = "";
  DOM.nuevaCancionArtista.value = "";
  DOM.nuevaCancionIdioma.value = "Inglés";
  DOM.nuevaCancionGenero.value = "";
  DOM.nuevaCancionLetraPublica.value = "";
  DOM.nuevaCancionLetraElena.value = "";
  DOM.nuevaCancionError.hidden = true;
  DOM.nuevaCancionModal.hidden = false;
  setTimeout(() => DOM.nuevaCancionNombre.focus(), 0);
}

function cerrarNuevaCancion() {
  DOM.nuevaCancionModal.hidden = true;
}

async function guardarCancionDesdePanel() {
  const titulo = DOM.nuevaCancionNombre.value.trim();
  const artista = DOM.nuevaCancionArtista.value.trim();
  if (!titulo) {
    DOM.nuevaCancionError.textContent = "Escribe el título de la canción.";
    DOM.nuevaCancionError.hidden = false;
    return;
  }
  if (estado.todas.some((c) => normalizar(c.titulo) === normalizar(titulo) && normalizar(c.artista) === normalizar(artista))) {
    DOM.nuevaCancionError.textContent = "Esta canción ya existe en la lista general.";
    DOM.nuevaCancionError.hidden = false;
    return;
  }
  const seleccionadas = [...DOM.nuevaCancionListas.querySelectorAll('input:checked:not(:disabled)')].map((i) => i.value);
  const listas = [...new Set([...seleccionadas, "todas"])];
  const categorias = DOM.nuevaCancionGenero.value.split(",").map((g) => g.trim()).filter(Boolean);
  const cancion = {
    id: crearIdCancion(titulo),
    titulo,
    artista,
    idioma: DOM.nuevaCancionIdioma.value,
    categorias: categorias.length ? categorias : ["Otros"],
    tranquila: false,
    listas
  };
  estado.todas.push(cancion);
  estado.todas.sort((a,b) => a.titulo.localeCompare(b.titulo, "es", { sensitivity: "base" }));
  guardarCancionesLocales();

  const publica = DOM.nuevaCancionLetraPublica.value.trim();
  const privada = DOM.nuevaCancionLetraElena.value.trim();
  if (publica || privada) {
    const publicaHtml = textoAHtmlLetra(publica || privada);
    const escenarioHtml = textoAHtmlLetra(privada || publica);
    estado.letras[cancion.id] = { titulo, artista, publicaHtml, escenarioHtml, local: true };
    guardarLetrasLocales();
  }

  aplicarModo();
  renderizarListaMaestra();
  renderizar();
  mostrarSelectorAdmin();
  cerrarNuevaCancion();
  mostrarAviso("Canción agregada exitosamente.");
}

function capturarDOM() {
  Object.assign(DOM, {
    landing: $("#landing"),
    panelBackButton: $("#panelBackButton"),
    app: $("#app"),
    seguirInstagram: $("#seguirInstagram"),
    continuar: $("#continuarExperiencia"),
    entrar: $("#entrarRepertorio"),
    mostrarTodo: $("#mostrarTodo"),
    textoMostrarTodo: $("#textoMostrarTodo"),
    totalBoton: $("#totalCancionesBoton"),
    buscar: $("#buscar"),
    limpiar: $("#limpiarBusqueda"),
    contador: $("#contadorCanciones"),
    lista: $("#listaCanciones"),
    sinResultados: $("#sinResultados"),
    errorCarga: $("#errorCarga"),
    reintentar: $("#reintentarCarga"),
    categorias: $$(".categoria"),
    controles: $("#controlesCanciones"),
    volver: $("#volverArriba"),
    anio: $("#anioActual"),
    adminTrigger: $("#adminTrigger"),
    adminTriggerPortada: $("#adminTriggerPortada"),
    adminModal: $("#adminModal"),
    adminAcceso: $("#adminAcceso"),
    adminSelector: $("#adminSelector"),
    adminClave: $("#adminClave"),
    adminError: $("#adminError"),
    adminIngresar: $("#adminIngresar"),
    adminOpciones: $("#adminOpciones"),
    adminGuardar: $("#adminGuardar"),
    adminNuevaCancion: $("#adminNuevaCancion"),
    adminEstado: $("#adminEstado"),
    adminPedidosWhatsapp: $("#adminPedidosWhatsapp"),
    adminMostrarCola: $("#adminMostrarCola"),
    adminLugar: $("#adminLugar"),
    adminBuscarCancion: $("#adminBuscarCancion"),
    adminListaCompleta: $("#adminListaCompleta"),
    adminColaFija: $("#adminColaFija"),
    adminColaFijaCantidad: $("#adminColaFijaCantidad"),
    adminColaFijaVacia: $("#adminColaFijaVacia"),
    adminFinalizarShow: $("#adminFinalizarShow"),
    adminVolverConfiguracion: $("#adminVolverConfiguracion"),
    adminSubir: $("#adminSubir"),
    adminPasoConfiguracion: $("#adminPasoConfiguracion"),
    adminPasoCanciones: $("#adminPasoCanciones"),
    adminVistaEstadisticas: $("#adminVistaEstadisticas"),
    adminVistaHerramientas: $("#adminVistaHerramientas"),
    adminVistaTitulo: $("#adminVistaTitulo"),
    adminShowLugar: $("#adminShowLugar"),
    adminShowLista: $("#adminShowLista"),
    adminShowPerfil: $("#adminShowPerfil"),
    adminAccionesCanciones: $("#adminAccionesCanciones"),
    adminMenuBoton: $("#adminMenuBoton"),
    adminMenuLateral: $("#adminMenuLateral"),
    adminCerrarSesion: $("#adminCerrarSesion"),
    letraModal: $("#letraModal"),
    letraTitulo: $("#letraTitulo"),
    letraArtista: $("#letraArtista"),
    letraContenido: $("#letraContenido"),
    letraEditar: $("#letraEditar"),
    letraToolbar: $("#letraToolbar"),
    letraGuardar: $("#letraGuardar"),
    letraCancelar: $("#letraCancelar"),
    letraColorBoton: $("#letraColorBoton"),
    letraColorMuestra: $("#letraColorMuestra"),
    letraColorMenu: $("#letraColorMenu"),
    letraTamanoBoton: $("#letraTamanoBoton"),
    letraTamanoMenu: $("#letraTamanoMenu"),
    letraIconosBoton: $("#letraIconosBoton"),
    letraIconosMenu: $("#letraIconosMenu"),
    letraDeshacer: $("#letraDeshacer"),
    letraRehacer: $("#letraRehacer"),
    adminAgregarLetra: $("#adminAgregarLetra"),
    adminAgregarMenu: $("#adminAgregarMenu"),
    agregarLetraModal: $("#agregarLetraModal"),
    agregarLetraTitulo: $("#agregarLetraTitulo"),
    agregarLetraCancion: $("#agregarLetraCancion"),
    agregarLetraExistenteCampos: $("#agregarLetraExistenteCampos"),
    agregarLetraModoExistente: $("#agregarLetraModoExistente"),
    agregarLetraNuevaCancion: $("#agregarLetraNuevaCancion"),
    agregarLetraNuevaCampos: $("#agregarLetraNuevaCampos"),
    agregarLetraNuevoTitulo: $("#agregarLetraNuevoTitulo"),
    agregarLetraNuevoArtista: $("#agregarLetraNuevoArtista"),
    agregarLetraNuevoGenero: $("#agregarLetraNuevoGenero"),
    agregarLetraTexto: $("#agregarLetraTexto"),
    agregarLetraGuardar: $("#agregarLetraGuardar"),
    agregarLetraCancelar: $("#agregarLetraCancelar"),
    agregarLetraError: $("#agregarLetraError"),
    nuevaCancionModal: $("#nuevaCancionModal"),
    nuevaCancionNombre: $("#nuevaCancionNombre"),
    nuevaCancionArtista: $("#nuevaCancionArtista"),
    nuevaCancionIdioma: $("#nuevaCancionIdioma"),
    nuevaCancionGenero: $("#nuevaCancionGenero"),
    nuevaCancionListas: $("#nuevaCancionListas"),
    nuevaCancionLetraPublica: $("#nuevaCancionLetraPublica"),
    nuevaCancionLetraElena: $("#nuevaCancionLetraElena"),
    nuevaCancionGuardar: $("#nuevaCancionGuardar"),
    nuevaCancionCancelar: $("#nuevaCancionCancelar"),
    nuevaCancionError: $("#nuevaCancionError"),
    confirmacionModal: $("#confirmacionModal"),
    confirmacionTitulo: $("#confirmacionTitulo"),
    confirmacionMensaje: $("#confirmacionMensaje"),
    confirmacionAceptar: $("#confirmacionAceptar"),
    confirmacionCancelar: $("#confirmacionCancelar"),
    avisoApp: $("#avisoApp"),
    firebaseEstado: $("#firebaseEstado"),
    estadoShowPublico: $("#estadoShowPublico"),
    colaPublica: $("#colaPublica"),
    colaPublicaVacia: $("#colaPublicaVacia"),
    tocadasPublicas: $("#tocadasPublicas"),
    tocadasPublicasVacia: $("#tocadasPublicasVacia"),
    pedidoModal: $("#pedidoModal"),
    pedidoCancion: $("#pedidoCancion"),
    pedidoTelefono: $("#pedidoTelefono"),
    pedidoError: $("#pedidoError"),
    pedidoEnviar: $("#pedidoEnviar"),
    adminCantidadContactos: $("#adminCantidadContactos"),
    adminListaContactos: $("#adminListaContactos"),
    adminFiltrosContactos: $$("[data-contactos-filtro]"),
    adminCompartirContactosElena: $("#adminCompartirContactosElena"),
    adminCompartirContactosDaniel: $("#adminCompartirContactosDaniel"),
    adminExportarContactos: $("#adminExportarContactos"),
    adminAbrirPublico: $("#adminAbrirPublico"),
    adminAbrirClientes: $("#adminAbrirClientes"),
    adminCopiarEnlace: $("#adminCopiarEnlace"),
    adminCompartirElena: $("#adminCompartirElena"),
    adminCompartirDaniel: $("#adminCompartirDaniel"),
    adminExportarDatos: $("#adminExportarDatos"),
    notasModal: $("#notasModal"),
    notasCancion: $("#notasCancion"),
    notasImagen: $("#notasImagen")
  });
}

async function cargarDatos() {
  const [respuestaCanciones, respuestaConfig] = await Promise.all([
    fetch(CONFIG.rutaCanciones, { cache: "no-store" }),
    fetch(CONFIG.rutaConfiguracion, { cache: "no-store" })
  ]);

  if (!respuestaCanciones.ok) {
    throw new Error("No se pudieron cargar las canciones.");
  }

  estado.todas = depurarCanciones(await respuestaCanciones.json());
  const cancionesLocales = JSON.parse(localStorage.getItem("egmCancionesLocales") || "[]");
  cancionesLocales.forEach((local) => {
    estado.todas.push(local);
  });
  estado.todas = depurarCanciones(estado.todas);
  estado.todas.sort((a,b) => a.titulo.localeCompare(b.titulo, "es", { sensitivity: "base" }));
  estado.todasLocalesBase = estado.todas.map((cancion) => ({ ...cancion }));

  const configuracion = respuestaConfig.ok
    ? await respuestaConfig.json()
    : {};

  estado.duracionShowMs =
    Number(configuracion.duracionShowHoras || 8) * 60 * 60 * 1000;

  const parametroLista = new URLSearchParams(window.location.search).get("lista");

  if (CATALOGO_PUBLICO) {
    // Esta copia NO obedece al repertorio activo del show.
    // Master = Todas las canciones, siempre.
    estado.modo = "todas";
    estado.modoForzado = true;
    estado.vistaClientes = true;
  } else if (parametroLista === "todas") {
    estado.modo = "todas";
    estado.modoForzado = true;
    estado.vistaClientes = true;
  } else {
    estado.modo = modoValido(parametroLista)
      ? parametroLista
      : (configuracion.modoPredeterminado || "principal-diario");
    estado.modoForzado = false;
    estado.vistaClientes = false;
  }

  iniciarFirebase(configuracion.firebase);
  aplicarModo(estado.modo, false);
}

function iniciarFirebase(firebaseConfig) {
  if (!firebaseConfig?.apiKey || !firebaseConfig?.projectId) {
    actualizarEstadoFirebase("Sin configuración", "error");
    return;
  }

  try {
    estado.firebase = initializeApp(firebaseConfig);
    estado.db = initializeFirestore(estado.firebase,{experimentalAutoDetectLongPolling:true,useFetchStreams:false});
    estado.estadoRef = doc(estado.db, "config", "estado");

    const crearFirmaEstadoRemoto = (datos = {}) => JSON.stringify({
      lista_activa: datos.lista_activa || datos.listaActiva || "",
      repertorio_activo_ids: Array.isArray(datos.repertorio_activo_ids)
        ? datos.repertorio_activo_ids
        : (Array.isArray(datos.repertorioActivoIds) ? datos.repertorioActivoIds : []),
      pedidos_whatsapp: Boolean(datos.pedidos_whatsapp),
      mostrar_cola: datos.mostrar_cola !== false,
      inicio_show: Number(datos.inicio_show || 0),
      cola: Array.isArray(datos.cola) ? datos.cola : [],
      tocadas: Array.isArray(datos.tocadas) ? datos.tocadas : [],
      lugar: String(datos.lugar || ""),
      perfil_clientes: String(datos.perfil_clientes || ""),
      show_activo: Boolean(datos.show_activo),
      biblioteca: datos.biblioteca || null
    });

    const procesarEstadoRemoto = async (snapshot) => {
      const datos = snapshot.exists() ? snapshot.data() : {};

      if (snapshot.exists()) {
        const firmaNueva = crearFirmaEstadoRemoto(datos);
        // El sondeo periódico queda como respaldo, pero un estado idéntico no
        // vuelve a reconstruir la lista ni reinicia sus animaciones visuales.
        if (firmaNueva === estado.firmaEstadoRemoto) return;
        estado.firmaEstadoRemoto = firmaNueva;
      }

      if (!snapshot.exists()) {
        if (!CATALOGO_PUBLICO) {
          await setDoc(
            estado.estadoRef,
            {
              lista_activa: estado.modo,
              pedidos_whatsapp: false,
              mostrar_cola: true,
              inicio_show: Date.now(),
              cola: [],
              tocadas: []
            },
            { merge: true }
          );
        }
        return;
      }

      const bibliotecaCambio = aplicarBibliotecaRemota(datos.biblioteca);
      const listaRemota = datos.lista_activa || datos.listaActiva || estado.modo;
      const idsRemotos = Array.isArray(datos.repertorio_activo_ids)
        ? datos.repertorio_activo_ids
        : (Array.isArray(datos.repertorioActivoIds) ? datos.repertorioActivoIds : null);
      estado.idsRepertorioRemoto = idsRemotos ? new Set(idsRemotos.map(String)) : null;
      // El id publicado por el panel es la fuente principal. Si además llegan
      // ids directos, se acepta aunque sea un repertorio personalizado nuevo.
      const listaAplicable = (estado.idsRepertorioRemoto || modoValido(listaRemota))
        ? listaRemota
        : "principal-diario";

      estado.configRemota = {
        lista_activa: listaAplicable,
        pedidos_whatsapp: Boolean(datos.pedidos_whatsapp),
        mostrar_cola: datos.mostrar_cola !== false,
        inicio_show: Number(datos.inicio_show || 0),
        cola: Array.isArray(datos.cola) ? datos.cola : [],
        tocadas: Array.isArray(datos.tocadas) ? datos.tocadas : [],
        lugar: String(datos.lugar || ""),
        perfil_clientes: ["alto", "medio", "bajo"].includes(datos.perfil_clientes)
          ? datos.perfil_clientes
          : "medio",
        show_activo: Boolean(datos.show_activo)
      };

      actualizarEstadoFirebase("En línea", "online");
      if (!CATALOGO_PUBLICO) {
        await comprobarReinicioAutomatico();
        await cargarContactos();
      }

      if (CATALOGO_PUBLICO && bibliotecaCambio) {
        aplicarModo("todas", false);
        estado.mostrar = true;
        renderizar();
      } else if (!estado.modoForzado && (estado.modo !== listaAplicable || bibliotecaCambio)) {
        aplicarModo(listaAplicable, false);
      }
      sincronizarInterfazRemota();
    };

    onSnapshot(
      estado.estadoRef,
      procesarEstadoRemoto,
      (error) => {
        console.error("Error de Firestore:", error);
        actualizarEstadoFirebase("Sin conexión", "error");
      }
    );

    // Respaldo para navegadores/redes donde el canal en tiempo real no avisa cambios.
    // Lee directamente el documento cada 4 segundos y aplica el repertorio nuevo.
    window.setInterval(async () => {
      if (!estado.estadoRef || document.hidden) return;
      try {
        const snapshot = await getDoc(estado.estadoRef);
        await procesarEstadoRemoto(snapshot);
      } catch (error) {
        console.warn("No se pudo comprobar el repertorio activo:", error);
      }
    }, 4000);
  } catch (error) {
    console.error("No se pudo iniciar Firebase:", error);
    actualizarEstadoFirebase("Error", "error");
  }
}

async function comprobarReinicioAutomatico() {
  if (
    !estado.estadoRef ||
    estado.reinicioEnCurso ||
    !estado.configRemota.inicio_show
  ) {
    return;
  }

  const vencido =
    Date.now() - estado.configRemota.inicio_show >= estado.duracionShowMs;

  if (!vencido) return;

  estado.reinicioEnCurso = true;

  try {
    await updateDoc(estado.estadoRef, {
      inicio_show: Date.now(),
      fin_show: null,
      show_activo: true,
      cola: [],
      tocadas: []
    });
  } catch (error) {
    console.error("No se pudo reiniciar automáticamente:", error);
  } finally {
    estado.reinicioEnCurso = false;
  }
}

function actualizarEstadoFirebase(texto, tipo = "") {
  if (!DOM.firebaseEstado) return;

  DOM.firebaseEstado.textContent = texto;
  DOM.firebaseEstado.classList.toggle("is-online", tipo === "online");
  DOM.firebaseEstado.classList.toggle("is-error", tipo === "error");
}


function actualizarCategoriasDisponibles() {
  DOM.categorias.forEach((boton) => {
    const categoria = boton.dataset.categoria;

    const tieneCanciones = estado.base.some((cancion) =>
      cancion.categorias.includes(categoria)
    );

    boton.hidden = !tieneCanciones;

    if (!tieneCanciones && estado.categoria === categoria) {
      estado.categoria = null;
      boton.classList.remove("is-active");
      boton.setAttribute("aria-pressed", "false");
    }
  });
}

function aplicarModo(modo, desplazar = true) {
  estado.modo = modo;
  const usarIdsRemotos =
    !CATALOGO_PUBLICO &&
    estado.idsRepertorioRemoto instanceof Set &&
    estado.configRemota?.lista_activa === modo;
  estado.base = usarIdsRemotos
    ? estado.todas.filter((cancion) => estado.idsRepertorioRemoto.has(String(cancion.id)))
    : estado.todas.filter((cancion) => Array.isArray(cancion.listas) && cancion.listas.includes(modo));
  estado.categoria = null;
  estado.consulta = "";
  estado.mostrar = false;

  if (DOM.buscar) DOM.buscar.value = "";

  DOM.categorias.forEach((boton) => {
    boton.classList.remove("is-active");
    boton.setAttribute("aria-pressed", "false");
  });

  actualizarCategoriasDisponibles();
  actualizarControles();
  renderizar();

  if (desplazar) {
    DOM.controles?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function obtenerVisibles() {
  if (!estado.mostrar && !estado.categoria && !normalizar(estado.consulta)) {
    return [];
  }

  const consulta = normalizar(estado.consulta).trim();

  return estado.base.filter((cancion) => {
    const coincideCategoria =
      !estado.categoria || cancion.categorias.includes(estado.categoria);

    // Búsqueda pública precisa: solo muestra títulos que comienzan
    // con las letras escritas, ignorando mayúsculas y tildes.
    const coincideBusqueda =
      !consulta ||
      normalizar(cancion.titulo).startsWith(consulta) ||
      normalizar(cancion.artista).startsWith(consulta);

    return coincideCategoria && coincideBusqueda;
  });
}

function actualizarControles() {
  const cantidad = estado.base.length;

  if (DOM.totalBoton) {
    DOM.totalBoton.textContent = String(cantidad);
  }

  if (DOM.textoMostrarTodo) {
    DOM.textoMostrarTodo.textContent = `Ver las ${cantidad} canciones`;
  }

  if (DOM.limpiar && DOM.buscar) {
    DOM.limpiar.hidden = !DOM.buscar.value;
  }
}

function estadoCancion(id) {
  if (estado.vistaClientes) return "disponible";
  if (estado.configRemota.tocadas.includes(id)) return "tocada";
  if (estado.configRemota.cola.includes(id)) return "cola";
  return "disponible";
}

function crearTarjeta(cancion, indice) {
  const situacion = estadoCancion(cancion.id);
  const articulo = document.createElement("article");

  articulo.className = "cancion cancion-enter";
  if (estado.cancionGritaActivaId === cancion.id) {
    articulo.classList.add("is-grita-activa");
  }
  articulo.dataset.id = cancion.id;
  articulo.dataset.estado = situacion;
  articulo.setAttribute("role", "listitem");
  articulo.tabIndex = 0;

  const etiquetaEstado =
    situacion === "cola"
      ? '<span class="cancion__estado cancion__estado--cola">Ya pedida</span>'
      : situacion === "tocada"
        ? '<span class="cancion__estado cancion__estado--tocada">Ya sonó</span>'
        : "";

  const puedePedir =
    !estado.vistaClientes &&
    estado.configRemota.pedidos_whatsapp &&
    situacion === "disponible";

  const botonPedido = estado.vistaClientes
    ? ""
    : puedePedir
      ? '<button class="cancion__pedir" type="button">Pedir por WhatsApp</button>'
      : situacion === "cola"
        ? '<button class="cancion__pedir" type="button" disabled>Esta canción ya fue pedida</button>'
        : situacion === "tocada"
          ? '<button class="cancion__pedir" type="button" disabled>Esta canción ya sonó</button>'
          : "";

  articulo.innerHTML = `
    ${etiquetaEstado}
    <div class="numero" aria-hidden="true">${numeroCancionEnLista(cancion.id) || indice + 1}</div>
    <div class="info">
      <h3 class="titulo">${escapar(cancion.titulo)}</h3>
      <p class="artista">${escapar(cancion.artista)}</p>
      <div class="tags">
        ${cancion.categorias
          .map((categoria) => `<span class="tag">${escapar(categoria)}</span>`)
          .join("")}
      </div>
      <button class="cancion__cerrar" type="button" aria-label="Cerrar">×</button>
      <div class="cancion__grita" aria-hidden="true">
        <span>¡Grita el número o el nombre!</span>
      </div>
      <div class="cancion__acciones">
        ${botonPedido}
        ${tieneLetra(cancion.id) ? '<button class="cancion__letra" type="button">Letra</button>' : ""}
      </div>
    </div>
  `;

  articulo
    .querySelector(".cancion__letra")
    ?.addEventListener("click", (evento) => {
      evento.stopPropagation();
      abrirLetra(cancion, false);
    });

  articulo
    .querySelector(".cancion__pedir:not([disabled])")
    ?.addEventListener("click", (evento) => {
      evento.stopPropagation();
      activarTarjetaWhatsApp(articulo, true);
      abrirPedido(cancion);
    });

  if (!estado.vistaClientes && estado.configRemota.pedidos_whatsapp && situacion === "disponible") {
    const alternarSeleccionWhatsApp = (evento) => {
      if (evento?.target?.closest("button, a, input, textarea, select")) return;
      const yaActiva = articulo.classList.contains("is-whatsapp-activa");
      document.querySelectorAll(".cancion.is-whatsapp-activa").forEach((otra) => {
        otra.classList.remove("is-whatsapp-activa");
      });
      if (!yaActiva) activarTarjetaWhatsApp(articulo, true);
    };

    articulo.addEventListener("click", alternarSeleccionWhatsApp);
    articulo.addEventListener("keydown", (evento) => {
      if ((evento.key === "Enter" || evento.key === " ") && evento.target === articulo) {
        evento.preventDefault();
        alternarSeleccionWhatsApp(evento);
      }
    });
  }

  if (!estado.vistaClientes && !estado.configRemota.pedidos_whatsapp && situacion === "disponible") {
    const mostrarIndicacion = () => {
      estado.cancionGritaActivaId = cancion.id;
      document.querySelectorAll(".cancion.is-grita-activa").forEach((otra) => {
        if (otra !== articulo) otra.classList.remove("is-grita-activa");
      });
      articulo.classList.add("is-grita-activa");
      // Permanece activa aunque la lista se vuelva a renderizar.
    };
    articulo.querySelector(".cancion__cerrar")?.addEventListener("click", (e) => {
      e.stopPropagation();
      estado.cancionGritaActivaId = null;
      articulo.classList.remove("is-grita-activa");
    });

    articulo.addEventListener("click", mostrarIndicacion);
    articulo.addEventListener("keydown", (evento) => {
      if (evento.key === "Enter" || evento.key === " ") {
        evento.preventDefault();
        mostrarIndicacion();
      }
    });
  }

  return articulo;
}

function renderizar() {
  estado.visibles = obtenerVisibles();
  DOM.lista.innerHTML = "";

  const listaCompleta =
    estado.mostrar &&
    !estado.categoria &&
    !normalizar(estado.consulta);

  DOM.lista.dataset.modo = listaCompleta ? "todas" : "filtrada";
  DOM.lista.style.setProperty(
    "--filas-lista",
    Math.ceil(estado.visibles.length / 2)
  );

  const fragmento = document.createDocumentFragment();

  estado.visibles.forEach((cancion, indice) => {
    fragmento.appendChild(crearTarjeta(cancion, indice));
  });

  DOM.lista.appendChild(fragmento);

  const hayFiltro =
    estado.mostrar ||
    Boolean(estado.categoria) ||
    Boolean(normalizar(estado.consulta));

  DOM.sinResultados.hidden = !(hayFiltro && estado.visibles.length === 0);

  if (!hayFiltro) {
    DOM.contador.textContent =
      `${estado.base.length} canciones disponibles en ${nombreModo(estado.modo)}.`;
  } else if (estado.visibles.length === estado.base.length) {
    DOM.contador.textContent =
      `${estado.base.length} canciones disponibles.`;
  } else {
    DOM.contador.textContent =
      `${estado.visibles.length} canciones encontradas.`;
  }
}

function sincronizarInterfazRemota() {
  renderizarEstadoPublico();
  renderizarColaFijaAdmin();

  if (DOM.adminPasoCanciones && !DOM.adminPasoCanciones.hidden) {
    renderizarListaMaestra();
  }

  if (DOM.adminPedidosWhatsapp) {
    DOM.adminPedidosWhatsapp.checked =
      estado.configRemota.pedidos_whatsapp;
  }

  if (DOM.adminMostrarCola) {
    DOM.adminMostrarCola.checked =
      estado.configRemota.mostrar_cola;
  }

  if (estado.visibles.length || estado.mostrar || estado.categoria || estado.consulta) {
    renderizar();
  }
}

function numeroCancionEnLista(idCancion) {
  const indice = estado.base.findIndex(
    (cancion) => cancion.id === idCancion
  );

  return indice >= 0 ? indice + 1 : null;
}

function renderizarColaFijaAdmin() {
  if (!DOM.adminColaFija) return;

  const canciones = estado.configRemota.cola
    .map(obtenerCancion)
    .filter(Boolean);

  DOM.adminColaFijaCantidad.textContent = String(canciones.length);
  DOM.adminColaFijaVacia.hidden = canciones.length > 0;

  DOM.adminColaFija.innerHTML = canciones
    .map((cancion) => {
      const numero = numeroCancionEnLista(cancion.id);

      return `
        <li>
          <span class="admin-cola-fija__numero">${numero || "—"}</span>
          <span class="admin-cola-fija__cancion">${escapar(cancion.titulo)}</span>

          <button
            class="admin-cola-fija__tocada"
            type="button"
            data-cola-fija-tocada="${cancion.id}"
          >
            Tocada
          </button>

          <button
            class="admin-cola-fija__quitar"
            type="button"
            data-cola-fija-quitar="${cancion.id}"
            aria-label="Quitar ${escapar(cancion.titulo)} de la cola"
            title="Quitar de la cola"
          >
            ×
          </button>
        </li>
      `;
    })
    .join("");

  DOM.adminColaFija
    .querySelectorAll("[data-cola-fija-tocada]")
    .forEach((boton) => {
      boton.addEventListener("click", async () => {
        await marcarTocada(boton.dataset.colaFijaTocada);
        renderizarColaFijaAdmin();
        renderizarListaMaestra();
      });
    });

  DOM.adminColaFija
    .querySelectorAll("[data-cola-fija-quitar]")
    .forEach((boton) => {
      boton.addEventListener("click", async () => {
        await quitarDeCola(boton.dataset.colaFijaQuitar);
        renderizarColaFijaAdmin();
        renderizarListaMaestra();
      });
    });
}

function actualizarPosicionMenuPublico() {
  if (!DOM.volver) return;

  const colaVisible =
    DOM.estadoShowPublico &&
    !DOM.estadoShowPublico.hidden &&
    DOM.estadoShowPublico.classList.contains(
      "cola-publica-compacta--con-canciones"
    );

  if (!colaVisible) {
    DOM.volver.style.removeProperty("--menu-publico-bottom");
    return;
  }

  const rectCola = DOM.estadoShowPublico.getBoundingClientRect();
  // El borde inferior del botón queda exactamente unido al borde superior
  // del panel que contiene el título “Canciones a la cola”. La variable CSS
  // evita que las reglas responsive con !important anulen esta posición.
  const distancia = Math.max(
    0,
    window.innerHeight - rectCola.top
  );

  DOM.volver.style.setProperty(
    "--menu-publico-bottom",
    `${Math.round(distancia)}px`
  );
}

function renderizarEstadoPublico() {
  // La cola debe aparecer también en teléfonos y en el enlace ?lista=todas.
  // Solo se oculta cuando Elena la desactiva desde el Panel Maestro.
  if (!estado.configRemota.mostrar_cola) {
    DOM.estadoShowPublico.hidden = true;
    document.body.classList.remove("cola-publica-visible");
    actualizarPosicionMenuPublico();
    return;
  }

  DOM.estadoShowPublico.hidden = false;
  document.body.classList.add("cola-publica-visible");

  const cancionesCola = estado.configRemota.cola
    .map(obtenerCancion)
    .filter(Boolean);

  DOM.colaPublica.innerHTML = cancionesCola
    .map((cancion) => {
      const numero = numeroCancionEnLista(cancion.id);

      return `
        <li>
          <span class="cola-publica-compacta__numero">${numero || "—"}</span>
          <span class="cola-publica-compacta__cancion">${escapar(cancion.titulo)}</span>
          <span class="cola-publica-compacta__estado">A la cola</span>
        </li>
      `;
    })
    .join("");

  DOM.colaPublicaVacia.hidden = cancionesCola.length > 0;

  const hayCancionesEnCola = cancionesCola.length > 0;
  DOM.estadoShowPublico.classList.toggle(
    "cola-publica-compacta--con-canciones",
    hayCancionesEnCola
  );
  document.body.classList.toggle(
    "cola-publica-visible",
    hayCancionesEnCola
  );

  requestAnimationFrame(actualizarPosicionMenuPublico);
}

function mostrarApp() {
  DOM.landing.hidden = true;
  DOM.app.hidden = false;
  document.body.classList.add("app-abierta");
  fijarMenu();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function fijarMenu() {
  if (!DOM.volver) return;

  if (DOM.volver.parentElement !== document.body) {
    document.body.appendChild(DOM.volver);
  }

  DOM.volver.hidden = false;

  Object.assign(DOM.volver.style, {
    position: "fixed",
    right: "16px",
    bottom: "max(16px, env(safe-area-inset-bottom))",
    zIndex: "99999",
    display: "inline-flex",
    visibility: "visible",
    opacity: "1"
  });
}

function mostrarContinuacion() {
  DOM.continuar.hidden = false;
  DOM.entrar.hidden = false;
  DOM.continuar.classList.remove("is-visible");
  void DOM.continuar.offsetWidth;
  DOM.continuar.classList.add("is-visible");
}

function guardarVisitaInstagram() {
  sessionStorage.setItem(CONFIG.claveInstagramVisitado, "1");
  sessionStorage.setItem(
    CONFIG.claveInstagramDesbloqueo,
    String(Date.now() + CONFIG.demoraContinuacionInstagram)
  );
}

function programarContinuacion() {
  if (sessionStorage.getItem(CONFIG.claveInstagramVisitado) !== "1") return;

  const demora = Math.max(
    0,
    Number(sessionStorage.getItem(CONFIG.claveInstagramDesbloqueo) || 0) -
      Date.now()
  );

  window.setTimeout(() => {
    if (!DOM.landing.hidden) mostrarContinuacion();
  }, demora);
}

function abrirInstagram() {
  abrirAplicacionConRespaldo(CONFIG.instagramApp, CONFIG.instagramWeb);
}

function abrirAplicacionConRespaldo(urlApp, urlWeb) {
  if (!esMovil()) {
    window.open(urlWeb, "_blank", "noopener,noreferrer");
    return;
  }

  // En móvil abrimos únicamente la aplicación.
  // Si la persona cancela el aviso del navegador, permanece en esta página.
  window.location.href = urlApp;
}

function abrirAdmin() {
  cancelarPulsacionAdmin();

  const clave = window.prompt("Contraseña del panel");
  if (clave === null) return;

  const seguridad = obtenerSeguridadLocal();
  if (clave.trim() !== String(seguridad.password || CONFIG.claveAdmin)) {
    window.alert("Contraseña incorrecta.");
    return;
  }

  // La clave ya fue validada en la página pública. Entregamos una autorización
  // limitada a esta pestaña para que panel.html no vuelva a pedirla.
  sessionStorage.setItem("egm-panel-auth", "1");
  window.location.href = "panel.html?trusted=1&live=1";
}

function cerrarAdmin() {
  DOM.adminModal.hidden = true;
  document.body.classList.remove("admin-abierto");
}

function mostrarSelectorAdmin() {
  DOM.adminAcceso.hidden = true;
  DOM.adminSelector.hidden = false;

  DOM.adminOpciones.innerHTML = MODOS.map((modo) => {
    const cantidad = estado.todas.filter((cancion) =>
      cancion.listas.includes(modo.id)
    ).length;

    return `
      <label class="admin-opcion">
        <input
          type="radio"
          name="modoAdmin"
          value="${modo.id}"
          ${modo.id === estado.configRemota.lista_activa ? "checked" : ""}
        >
        <span class="admin-opcion__nombre">${modo.nombre}</span>
        <span class="admin-opcion__cantidad">${cantidad}</span>
      </label>
    `;
  }).join("");

  DOM.adminPedidosWhatsapp.checked =
    estado.configRemota.pedidos_whatsapp;

  DOM.adminMostrarCola.checked =
    estado.configRemota.mostrar_cola;

  DOM.adminLugar.value = estado.configRemota.lugar || "";

  const perfil = document.querySelector(
    `input[name="perfilClientes"][value="${estado.configRemota.perfil_clientes}"]`
  );

  if (perfil) perfil.checked = true;

  mostrarVistaAdmin("configuracion");
}

function iniciarPulsacionAdmin() {
  window.clearTimeout(estado.temporizadorAdmin);
  estado.temporizadorAdmin = window.setTimeout(
    abrirAdmin,
    CONFIG.duracionPulsacionAdmin
  );
}

function cancelarPulsacionAdmin() {
  window.clearTimeout(estado.temporizadorAdmin);
}

async function guardarConfiguracionAdmin() {
  if (!estado.estadoRef) {
    DOM.adminEstado.textContent = "Firebase todavía no está conectado.";
    return;
  }

  const listaElegida =
    document.querySelector('input[name="modoAdmin"]:checked')?.value ||
    estado.configRemota.lista_activa;

  const perfilElegido =
    document.querySelector('input[name="perfilClientes"]:checked')?.value ||
    "medio";

  const lugar = DOM.adminLugar.value.trim();

  DOM.adminEstado.textContent = "Guardando configuración…";

  try {
    await setDoc(
      estado.estadoRef,
      {
        lista_activa: listaElegida,
        listaActiva: listaElegida,
        pedidos_whatsapp: DOM.adminPedidosWhatsapp.checked,
        mostrar_cola: DOM.adminMostrarCola.checked,
        lugar,
        perfil_clientes: perfilElegido,
        inicio_show: Date.now(),
        fin_show: null,
        show_activo: true,
        cola: [],
        tocadas: []
      },
      { merge: true }
    );

    estado.configRemota.lista_activa = listaElegida;
    estado.configRemota.lugar = lugar;
    estado.configRemota.perfil_clientes = perfilElegido;
    estado.configRemota.show_activo = true;

    if (!estado.modoForzado) {
      aplicarModo(listaElegida, false);
    }

    DOM.adminEstado.textContent = "";
    mostrarVistaAdmin("canciones");
  } catch (error) {
    console.error(error);
    DOM.adminEstado.textContent =
      "No se pudo guardar. Revisa Firebase y las reglas de Firestore.";
  }
}


function slugAnotacion(titulo = "") {
  return normalizar(titulo)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function cargarIndiceAnotaciones() {
  if (estado.indiceAnotacionesCargado) {
    return estado.indiceAnotaciones;
  }

  try {
    const respuesta = await fetch(CONFIG.rutaIndiceAnotaciones, {
      cache: "no-store"
    });

    if (!respuesta.ok) {
      throw new Error("No se pudo cargar el índice de anotaciones.");
    }

    estado.indiceAnotaciones = await respuesta.json();
  } catch (error) {
    console.error("Error al cargar anotaciones:", error);
    estado.indiceAnotaciones = {};
  }

  estado.indiceAnotacionesCargado = true;
  return estado.indiceAnotaciones;
}

function variantesIndiceAnotacion(titulo = "") {
  const completo = slugAnotacion(titulo);
  const sinArticulo = completo.replace(
    /^(el|la|los|las|un|una|the)-/,
    ""
  );

  const especiales = {
    "somebodys-watching-me": ["somebody-s-watching-me"],
    "me-and-mr-jones": ["me-mr-jones"],
    "tears-dry-on-their-own": ["tears-dry-original"],
    "these-boots-are-made-for-walkin-sinatra": [
      "these-boots-are-made-for-walkin",
      "these-boots-are-made-for-walking"
    ],
    "ill-take-care-of-you": ["take-care-of-you"],
    "its-a-pitty": ["its-a-pity"],
    "la-muralla-verde": ["la-muralla", "muralla-verde"],
    "una-luna-de-miel-en-la-mano": ["luna-de-miel"],
    "fuck-me-pumps": ["fuck-me"],
    "you-sent-me-flying": ["sent-me"]
  };

  return [
    completo,
    sinArticulo !== completo ? sinArticulo : null,
    ...(especiales[completo] || [])
  ].filter((valor, indice, lista) =>
    valor && lista.indexOf(valor) === indice
  );
}

async function detectarAnotacion(cancion) {
  if (!cancion) return null;

  if (estado.anotacionesCache.has(cancion.id)) {
    return estado.anotacionesCache.get(cancion.id);
  }

  const indice = await cargarIndiceAnotaciones();

  for (const variante of variantesIndiceAnotacion(cancion.titulo)) {
    const archivos = indice[variante];

    if (Array.isArray(archivos) && archivos.length) {
      const ruta = `${CONFIG.rutaAnotaciones}/${archivos[0]}`;
      estado.anotacionesCache.set(cancion.id, ruta);
      return ruta;
    }
  }

  estado.anotacionesCache.set(cancion.id, null);
  return null;
}

async function abrirNotas(cancion) {
  const ruta = await detectarAnotacion(cancion);

  if (!ruta) {
    DOM.adminEstado.textContent =
      `No hay anotaciones para “${cancion.titulo}”.`;
    return;
  }

  DOM.notasCancion.textContent = `${cancion.titulo} — ${cancion.artista}`;
  DOM.notasImagen.src = ruta;
  DOM.notasImagen.alt = `Anotaciones de ${cancion.titulo}`;
  DOM.notasModal.hidden = false;
  document.body.classList.add("notas-abiertas");
}

function cerrarNotas() {
  DOM.notasModal.hidden = true;
  DOM.notasImagen.removeAttribute("src");

  if (DOM.notasNavegacion) {
    DOM.notasNavegacion.hidden = true;
  }

  estado.paginasNotas = [];
  estado.indicePaginaNotas = 0;
  document.body.classList.remove("notas-abiertas");

  if (DOM.adminSelector && !DOM.adminSelector.hidden) {
    mostrarVistaAdmin("canciones");
  }
}

async function añadirBotonesNotas(resultados) {
  await Promise.all(
    resultados.map(async (cancion) => {
      const ruta = await detectarAnotacion(cancion);
      if (!ruta) return;

      const tarjeta = document.querySelector(
        `.admin-cancion[data-cancion-id="${CSS.escape(cancion.id)}"]`
      );

      if (!tarjeta || tarjeta.querySelector("[data-admin-notas]")) return;

      const boton = document.createElement("button");
      boton.className =
        "admin-cancion__accion admin-cancion__accion--notas";
      boton.type = "button";
      boton.dataset.adminNotas = cancion.id;
      boton.textContent = "Notas";
      boton.addEventListener("click", () => abrirNotas(cancion));
      tarjeta.appendChild(boton);
    })
  );
}


function nombrePerfil(perfil) {
  return perfil === "alto"
    ? "Alto potencial"
    : perfil === "bajo"
      ? "Bajo potencial"
      : "Potencial medio";
}

function ocultarVistasAdmin() {
  [
    DOM.adminPasoConfiguracion,
    DOM.adminPasoCanciones,
    DOM.adminVistaEstadisticas,
    DOM.adminVistaHerramientas
  ].forEach((vista) => {
    if (vista) vista.hidden = true;
  });

  if (DOM.adminAccionesCanciones) {
    DOM.adminAccionesCanciones.hidden = true;
  }
}

function cerrarMenuAdmin() {
  DOM.adminMenuLateral.hidden = true;
  DOM.adminMenuBoton.setAttribute("aria-expanded", "false");
}

function mostrarVistaAdmin(vista) {
  ocultarVistasAdmin();
  cerrarMenuAdmin();

  if (vista === "canciones") {
    DOM.adminVistaTitulo.textContent = "Control de canciones";
    DOM.adminPasoCanciones.hidden = false;

    if (DOM.adminAccionesCanciones) {
      DOM.adminAccionesCanciones.hidden = false;
    }
    DOM.adminShowLugar.textContent =
      estado.configRemota.lugar || "Sin definir";
    DOM.adminShowLista.textContent =
      nombreModo(estado.configRemota.lista_activa);
    DOM.adminShowPerfil.textContent =
      nombrePerfil(estado.configRemota.perfil_clientes);
    DOM.adminBuscarCancion.value = "";
    renderizarColaFijaAdmin();
    renderizarListaMaestra();
    return;
  }

  if (vista === "estadisticas") {
    DOM.adminVistaTitulo.textContent = "Estadísticas y contactos";
    DOM.adminVistaEstadisticas.hidden = false;
    cargarContactos();
    return;
  }

  if (vista === "herramientas") {
    DOM.adminVistaTitulo.textContent = "Compartir y enlaces";
    DOM.adminVistaHerramientas.hidden = false;
    return;
  }

  DOM.adminVistaTitulo.textContent = "Configuración del show";
  DOM.adminPasoConfiguracion.hidden = false;
}

function cancionesPanelMaestro() {
  const consultaOriginal = String(
    DOM.adminBuscarCancion?.value || ""
  ).trim();

  if (!consultaOriginal) {
    return estado.base;
  }

  // Si Elena escribe únicamente un número, busca la posición
  // consecutiva de la canción dentro de la lista activa.
  if (/^\d+$/.test(consultaOriginal)) {
    const numeroBuscado = Number(consultaOriginal);

    return estado.base.filter(
      (cancion, indice) => indice + 1 === numeroBuscado
    );
  }

  const consulta = normalizar(consultaOriginal);
  const terminos = consulta.split(" ").filter(Boolean);

  return estado.base.filter((cancion) => {
    const texto = normalizar(`${cancion.titulo} ${cancion.artista}`);
    return terminos.every((termino) => texto.includes(termino));
  });
}

async function crearFilaMaestra(cancion, indice) {
  const situacion = estadoCancion(cancion.id);
  const fila = document.createElement("article");

  fila.className = "admin-lista-cancion";
  fila.dataset.estado = situacion;
  fila.dataset.cancionId = cancion.id;

  fila.innerHTML = `
    <span class="admin-lista-cancion__numero" aria-hidden="true">${indice + 1}</span>

    <div class="admin-lista-cancion__info">
      <strong>${escapar(cancion.titulo)}</strong>
      <small>${escapar(cancion.artista)} · ${
        situacion === "tocada"
          ? "Ya sonó"
          : situacion === "cola"
            ? "En cola"
            : "Disponible"
      }</small>
    </div>

    <button
      class="admin-lista-cancion__boton admin-lista-cancion__boton--tocada"
      type="button"
      data-maestra-tocada="${cancion.id}"
    >
      Tocada
    </button>

    <button
      class="admin-lista-cancion__boton admin-lista-cancion__boton--cola"
      type="button"
      data-maestra-cola="${cancion.id}"
      ${situacion === "cola" ? "disabled" : ""}
    >
      ${situacion === "cola" ? "En cola" : "A la cola"}
    </button>
  `;

  if (tieneLetra(cancion.id)) {
    const botonLetra = document.createElement("button");
    botonLetra.className =
      "admin-lista-cancion__boton admin-lista-cancion__boton--letra";
    botonLetra.type = "button";
    botonLetra.textContent = "Letra";
    botonLetra.addEventListener("click", () => abrirLetra(cancion, true));
    fila.appendChild(botonLetra);
  }

  const anotacion = await detectarAnotacion(cancion);

  if (anotacion) {
    const botonNotas = document.createElement("button");
    botonNotas.className =
      "admin-lista-cancion__boton admin-lista-cancion__boton--notas";
    botonNotas.type = "button";
    botonNotas.textContent = "Notas";
    botonNotas.addEventListener("click", () => abrirNotas(cancion));
    fila.appendChild(botonNotas);
  }

  fila
    .querySelector("[data-maestra-tocada]")
    .addEventListener("click", async () => {
      await marcarTocada(cancion.id);
      renderizarListaMaestra();
    });

  const botonCola = fila.querySelector("[data-maestra-cola]");

  if (!botonCola.disabled) {
    botonCola.addEventListener("click", async () => {
      await agregarACola(cancion.id);
      renderizarColaFijaAdmin();
      renderizarListaMaestra();
    });
  }

  return fila;
}

async function renderizarListaMaestra() {
  if (!DOM.adminListaCompleta || DOM.adminPasoCanciones.hidden) return;

  const canciones = cancionesPanelMaestro();
  DOM.adminListaCompleta.innerHTML = "";

  if (!canciones.length) {
    DOM.adminListaCompleta.innerHTML =
      '<p class="admin-panel__ayuda">No encontramos esa canción.</p>';
    return;
  }

  const fragmento = document.createDocumentFragment();

  for (const cancion of canciones) {
    const indiceOriginal = estado.base.findIndex(
      (elemento) => elemento.id === cancion.id
    );

    fragmento.appendChild(
      await crearFilaMaestra(cancion, indiceOriginal)
    );
  }

  DOM.adminListaCompleta.appendChild(fragmento);
}

function buscarCancionesAdmin() {
  const consulta = normalizar(DOM.adminBuscarCancion.value);

  if (!consulta) {
    DOM.adminResultadosCanciones.innerHTML =
      '<p class="admin-panel__ayuda">Busca una canción para agregarla a la cola o marcarla como tocada.</p>';
    return;
  }

  const terminos = consulta.split(" ").filter(Boolean);

  const resultados = estado.base
    .filter((cancion) => {
      const texto = normalizar(`${cancion.titulo} ${cancion.artista}`);
      return terminos.every((termino) => texto.includes(termino));
    })
    .slice(0, 8);

  if (!resultados.length) {
    DOM.adminResultadosCanciones.innerHTML =
      '<p class="admin-panel__ayuda">No encontramos esa canción.</p>';
    return;
  }

  DOM.adminResultadosCanciones.innerHTML = resultados
    .map((cancion) => {
      const situacion = estadoCancion(cancion.id);

      return `
        <article class="admin-cancion" data-cancion-id="${cancion.id}">
          <div class="admin-cancion__info">
            <strong>${escapar(cancion.titulo)}</strong>
            <small>${escapar(cancion.artista)} · ${situacion === "cola" ? "En cola" : situacion === "tocada" ? "Ya sonó" : "Disponible"}</small>
          </div>

          <button
            class="admin-cancion__accion admin-cancion__accion--tocada"
            type="button"
            data-admin-tocada="${cancion.id}"
          >
            Tocada
          </button>

          <button
            class="admin-cancion__accion admin-cancion__accion--cola"
            type="button"
            data-admin-cola="${cancion.id}"
          >
            A la cola
          </button>
        </article>
      `;
    })
    .join("");

  $$("[data-admin-cola]").forEach((boton) => {
    boton.addEventListener("click", () =>
      agregarACola(boton.dataset.adminCola)
    );
  });

  $$("[data-admin-tocada]").forEach((boton) => {
    boton.addEventListener("click", () =>
      marcarTocada(boton.dataset.adminTocada)
    );
  });

  añadirBotonesNotas(resultados);
}

function canonicalizarColaAdminLegacy(cola, tocadas) {
  const source = [...new Set((Array.isArray(cola) ? cola : []).map(String))];
  const playedOrder = [...new Set((Array.isArray(tocadas) ? tocadas : []).map(String))];
  const playedSet = new Set(playedOrder);
  const sourceSet = new Set(source);
  const pendientes = source.filter((id) => !playedSet.has(id));
  const hechas = playedOrder.filter((id) => sourceSet.has(id));
  return [...pendientes, ...hechas];
}

function reactivarAlFinalPendientesAdminLegacy(cola, idCancion, tocadas) {
  const id = String(idCancion);
  const playedOrder = [...new Set((Array.isArray(tocadas) ? tocadas : []).map(String))];
  const playedSet = new Set(playedOrder);
  const canonical = canonicalizarColaAdminLegacy(cola, playedOrder).filter((x) => x !== id);
  const pendientes = canonical.filter((x) => !playedSet.has(x));
  const hechas = canonical.filter((x) => playedSet.has(x));
  return [...pendientes, id, ...hechas];
}

async function mutarColaAdminLegacy(idCancion, tipo) {
  if (!estado.estadoRef || !estado.db || !idCancion) return;
  const id = String(idCancion);

  return runTransaction(estado.db, async (transaction) => {
    const snap = await transaction.get(estado.estadoRef);
    const data = snap.exists() ? (snap.data() || {}) : {};
    if (data.show_activo === false) return;

    let cola = Array.isArray(data.cola) ? [...new Set(data.cola.map(String))] : [];
    let tocadas = Array.isArray(data.tocadas) ? [...new Set(data.tocadas.map(String))] : [];

    if (tipo === "add") {
      tocadas = tocadas.filter((x) => x !== id);
      cola = reactivarAlFinalPendientesAdminLegacy(cola, id, tocadas);
    } else if (tipo === "remove") {
      cola = cola.filter((x) => x !== id);
      tocadas = tocadas.filter((x) => x !== id);
    } else if (tipo === "play") {
      if (!tocadas.includes(id)) tocadas.push(id);
      cola = canonicalizarColaAdminLegacy(cola, tocadas);
    }

    const revision = Date.now();
    transaction.update(estado.estadoRef, {
      cola,
      tocadas,
      show_revision: revision,
      show_writer: "panel-legacy-6.36.92",
      updated_at: revision
    });
  });
}

async function agregarACola(idCancion) {
  if (!estado.estadoRef || !idCancion) return;

  try {
    await mutarColaAdminLegacy(idCancion, "add");
    DOM.adminEstado.textContent = "Canción agregada a la cola.";
  } catch (error) {
    console.error(error);
    DOM.adminEstado.textContent = "No se pudo agregar la canción.";
  }
}

async function quitarDeCola(idCancion) {
  if (!estado.estadoRef || !idCancion) return;

  try {
    await mutarColaAdminLegacy(idCancion, "remove");
  } catch (error) {
    console.error(error);
  }
}

async function marcarTocada(idCancion) {
  if (!estado.estadoRef || !idCancion) return;

  try {
    await mutarColaAdminLegacy(idCancion, "play");
    DOM.adminEstado.textContent = "Canción marcada como tocada.";
  } catch (error) {
    console.error(error);
    DOM.adminEstado.textContent = "No se pudo marcar la canción.";
  }
}

function renderizarAdminCola() {
  if (!DOM.adminCola) return;

  const canciones = estado.configRemota.cola
    .map(obtenerCancion)
    .filter(Boolean);

  DOM.adminCantidadCola.textContent = String(canciones.length);
  DOM.adminColaVacia.hidden = canciones.length > 0;

  DOM.adminCola.innerHTML = canciones
    .map(
      (cancion, indice) => `
        <li>
          <span class="admin-cola__numero">${indice + 1}</span>
          <span class="admin-cola__nombre">${escapar(cancion.titulo)} · ${escapar(cancion.artista)}</span>

          <button
            class="admin-cola__boton"
            type="button"
            data-cola-tocada="${cancion.id}"
          >
            Tocada
          </button>

          <button
            class="admin-cola__boton admin-cola__boton--quitar"
            type="button"
            data-cola-quitar="${cancion.id}"
          >
            Quitar
          </button>
        </li>
      `
    )
    .join("");

  $$("[data-cola-tocada]").forEach((boton) => {
    boton.addEventListener("click", () =>
      marcarTocada(boton.dataset.colaTocada)
    );
  });

  $$("[data-cola-quitar]").forEach((boton) => {
    boton.addEventListener("click", () =>
      quitarDeCola(boton.dataset.colaQuitar)
    );
  });
}


async function finalizarShow() {
  if (!estado.estadoRef) return;

  const confirmar = window.confirm(
    "¿Estás seguro de finalizar el show?\n\n" +
    "Se reiniciarán la cola y los estados de todas las canciones."
  );

  if (!confirmar) return;

  DOM.adminEstado.textContent = "Finalizando show…";

  try {
    await updateDoc(estado.estadoRef, {
      show_activo: false,
      fin_show: Date.now(),
      inicio_show: Date.now(),
      cola: [],
      tocadas: []
    });

    estado.configRemota.cola = [];
    estado.configRemota.tocadas = [];
    estado.configRemota.show_activo = false;

    mostrarVistaAdmin("configuracion");
    DOM.adminEstado.textContent = "Show finalizado. Los estados fueron reiniciados.";
  } catch (error) {
    console.error(error);
    DOM.adminEstado.textContent = "No se pudo finalizar el show.";
  }
}

async function reiniciarShow() {
  if (!estado.estadoRef) return;

  const confirmar = window.confirm(
    "¿Seguro que quieres borrar la cola y todos los estados de las canciones?"
  );

  if (!confirmar) return;

  DOM.adminEstado.textContent = "Reiniciando show…";

  try {
    await updateDoc(estado.estadoRef, {
      inicio_show: Date.now(),
      fin_show: null,
      show_activo: true,
      cola: [],
      tocadas: []
    });

    DOM.adminEstado.textContent = "Estados del show reiniciados.";
  } catch (error) {
    console.error(error);
    DOM.adminEstado.textContent = "No se pudo reiniciar el show.";
  }
}

function activarTarjetaWhatsApp(articulo, forzar = false) {
  if (!articulo) return;
  document.querySelectorAll(".cancion.is-whatsapp-activa").forEach((otra) => {
    if (otra !== articulo) otra.classList.remove("is-whatsapp-activa");
  });
  articulo.classList.toggle("is-whatsapp-activa", forzar ? true : undefined);
}

function limpiarSeleccionWhatsApp() {
  document.querySelectorAll(".cancion.is-whatsapp-activa").forEach((tarjeta) => {
    tarjeta.classList.remove("is-whatsapp-activa");
  });
}

function abrirPedido(cancion) {
  estado.pedidoSeleccionado = cancion;
  DOM.pedidoCancion.textContent = `${cancion.titulo} — ${cancion.artista}`;
  DOM.pedidoTelefono.value = "";
  DOM.pedidoError.hidden = true;
  DOM.pedidoModal.hidden = false;
}

function cerrarPedido() {
  DOM.pedidoModal.hidden = true;
  estado.pedidoSeleccionado = null;
  limpiarSeleccionWhatsApp();
}

async function enviarPedidoWhatsApp() {
  const cancion = estado.pedidoSeleccionado;

  if (!cancion) return;

  const nombre = "Sin nombre";
  const telefono = normalizarTelefono(DOM.pedidoTelefono.value);

  if (!telefonoValido(telefono)) {
    DOM.pedidoError.hidden = false;
    return;
  }

  DOM.pedidoError.hidden = true;
  DOM.pedidoEnviar.disabled = true;
  DOM.pedidoEnviar.textContent = "Abriendo WhatsApp…";

  try {
    await guardarContactoYPedido(cancion);
    await agregarACola(cancion.id);
    await cargarContactos();

    const mensaje = encodeURIComponent(
      `Hola Elena Girjoaba Music 👋\n\nSoy ${nombre}. Quisiera pedir esta canción:\n${cancion.titulo} — ${cancion.artista}\n\n¡Gracias!`
    );

    const app = `whatsapp://send?phone=${telefonoWhatsAppActual()}&text=${mensaje}`;
    const web = `https://wa.me/${telefonoWhatsAppActual()}?text=${mensaje}`;

    cerrarPedido();
    abrirAplicacionConRespaldo(app, web);
  } finally {
    DOM.pedidoEnviar.disabled = false;
    DOM.pedidoEnviar.textContent = "Enviar por WhatsApp";
  }
}



function normalizarTelefono(valor = "") {
  let digitos = String(valor).replace(/\D/g, "");

  if (digitos.startsWith("0")) {
    digitos = `593${digitos.slice(1)}`;
  }

  if (!digitos.startsWith("593") && digitos.length === 9) {
    digitos = `593${digitos}`;
  }

  return digitos;
}

function telefonoValido(valor = "") {
  const telefono = normalizarTelefono(valor);
  return /^593\d{9}$/.test(telefono);
}

function idContactoDesdeTelefono(telefono) {
  return `tel_${telefono}`;
}

function idShowActual() {
  return String(estado.configRemota.inicio_show || Date.now());
}

async function guardarContactoYPedido(cancion) {
  const nombre = "Sin nombre";
  const telefono = normalizarTelefono(DOM.pedidoTelefono.value);
  const ahora = Date.now();
  const showId = idShowActual();

  const contactoRef = doc(
    estado.db,
    "contactos",
    idContactoDesdeTelefono(telefono)
  );

  await setDoc(
    contactoRef,
    {
      nombre,
      telefono,
      creado_en: serverTimestamp(),
      creado_en_ms: ahora,
      ultima_interaccion: serverTimestamp(),
      ultima_interaccion_ms: ahora,
      total_pedidos: 1,
      primer_show_id: showId,
      ultimo_show_id: showId,
      ultimo_lugar: estado.configRemota.lugar || "",
      perfil_clientes: estado.configRemota.perfil_clientes || "medio",
      shows: arrayUnion(showId)
    },
    { merge: true }
  );

  // Incremento simple y seguro para el prototipo:
  const contactoSnapshot = await getDocs(
    query(
      collection(estado.db, "contactos"),
      where("telefono", "==", telefono)
    )
  );

  let totalPedidos = 1;

  contactoSnapshot.forEach((documento) => {
    const actual = Number(documento.data().total_pedidos || 0);
    totalPedidos = Math.max(totalPedidos, actual + 1);
  });

  await setDoc(
    contactoRef,
    {
      nombre,
      telefono,
      ultima_interaccion: serverTimestamp(),
      ultima_interaccion_ms: ahora,
      total_pedidos: totalPedidos,
      ultimo_show_id: showId,
      ultimo_lugar: estado.configRemota.lugar || "",
      perfil_clientes: estado.configRemota.perfil_clientes || "medio",
      shows: arrayUnion(showId)
    },
    { merge: true }
  );

  const pedidoRef = doc(collection(estado.db, "pedidos"));

  await setDoc(pedidoRef, {
    contacto_id: idContactoDesdeTelefono(telefono),
    nombre,
    telefono,
    cancion_id: cancion.id,
    cancion: cancion.titulo,
    artista: cancion.artista,
    show_id: showId,
    lista_activa: estado.configRemota.lista_activa,
    creado_en: serverTimestamp(),
    creado_en_ms: ahora,
    origen: "whatsapp",
    estado: "cola",
    lugar: estado.configRemota.lugar || "",
    perfil_clientes: estado.configRemota.perfil_clientes || "medio"
  });
}

async function cargarContactos() {
  if (!estado.db) return;

  try {
    const snapshot = await getDocs(collection(estado.db, "contactos"));
    estado.contactos = snapshot.docs.map((documento) => ({
      id: documento.id,
      ...documento.data()
    }));

    renderizarContactosAdmin();
  } catch (error) {
    console.error("No se pudieron cargar los contactos:", error);
  }
}

function contactosFiltrados() {
  const ahora = Date.now();
  const hace30Dias = ahora - 30 * 24 * 60 * 60 * 1000;
  const showId = idShowActual();

  return estado.contactos
    .filter((contacto) => {
      if (estado.filtroContactos === "show") {
        return Array.isArray(contacto.shows) && contacto.shows.includes(showId);
      }

      if (estado.filtroContactos === "mes") {
        return Number(contacto.ultima_interaccion_ms || 0) >= hace30Dias;
      }

      return true;
    })
    .sort(
      (a, b) =>
        Number(b.ultima_interaccion_ms || 0) -
        Number(a.ultima_interaccion_ms || 0)
    );
}

function formatearFechaHora(ms) {
  if (!ms) return "Fecha no disponible";

  return new Intl.DateTimeFormat("es-EC", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(ms));
}

function renderizarContactosAdmin() {
  if (!DOM.adminListaContactos) return;

  const contactos = contactosFiltrados();
  DOM.adminCantidadContactos.textContent = String(contactos.length);

  if (!contactos.length) {
    DOM.adminListaContactos.innerHTML =
      '<p class="admin-panel__ayuda">No hay contactos para este filtro.</p>';
    return;
  }

  DOM.adminListaContactos.innerHTML = contactos
    .map(
      (contacto) => `
        <article class="admin-contacto">
          <div class="admin-contacto__info">
            <strong>${escapar(contacto.nombre || "Sin nombre")}</strong>
            <span>+${escapar(contacto.telefono || "")}</span>
            <small>
              Agregado: ${escapar(formatearFechaHora(contacto.creado_en_ms))}
              · Última interacción: ${escapar(formatearFechaHora(contacto.ultima_interaccion_ms))}
            </small>
          </div>
          <span class="admin-contacto__pedidos" title="Pedidos">
            ${Number(contacto.total_pedidos || 0)}
          </span>
        </article>
      `
    )
    .join("");
}

function construirResumenContactos() {
  const contactos = contactosFiltrados();

  const titulo =
    estado.filtroContactos === "show"
      ? "Contactos de este show"
      : estado.filtroContactos === "mes"
        ? "Contactos de los últimos 30 días"
        : "Todos los contactos";

  const lineas = contactos.length
    ? contactos.map(
        (contacto, indice) =>
          `${indice + 1}. ${contacto.nombre || "Sin nombre"} · +${contacto.telefono} · ${contacto.total_pedidos || 0} pedidos · ${formatearFechaHora(contacto.creado_en_ms)}`
      )
    : ["Sin contactos"];

  return [
    "Elena Girjoaba Music",
    titulo,
    `Total: ${contactos.length}`,
    "",
    ...lineas
  ].join("\n");
}

function compartirContactosWhatsapp(numero) {
  const mensaje = encodeURIComponent(construirResumenContactos());
  abrirAplicacionConRespaldo(
    `whatsapp://send?phone=${numero}&text=${mensaje}`,
    `https://wa.me/${numero}?text=${mensaje}`
  );
}

function exportarContactos() {
  const contactos = contactosFiltrados();
  const encabezados = [
    "nombre",
    "telefono",
    "fecha_agregado",
    "ultima_interaccion",
    "total_pedidos"
  ];

  const filas = contactos.map((contacto) => [
    contacto.nombre || "",
    `+${contacto.telefono || ""}`,
    formatearFechaHora(contacto.creado_en_ms),
    formatearFechaHora(contacto.ultima_interaccion_ms),
    Number(contacto.total_pedidos || 0)
  ]);

  const csv = [encabezados, ...filas]
    .map((fila) =>
      fila
        .map((valor) => `"${String(valor).replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  const archivo = new Blob(["\ufeff" + csv], {
    type: "text/csv;charset=utf-8"
  });

  const url = URL.createObjectURL(archivo);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = `contactos-elena-girjoaba-${estado.filtroContactos}.csv`;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}

function construirResumenShow() {
  const cola = estado.configRemota.cola
    .map(obtenerCancion)
    .filter(Boolean);

  const tocadas = estado.configRemota.tocadas
    .map(obtenerCancion)
    .filter(Boolean);

  const lineasCola = cola.length
    ? cola.map((cancion, indice) => `${indice + 1}. ${cancion.titulo} — ${cancion.artista}`)
    : ["Sin canciones en cola"];

  const lineasTocadas = tocadas.length
    ? tocadas.map((cancion, indice) => `${indice + 1}. ${cancion.titulo} — ${cancion.artista}`)
    : ["Sin canciones marcadas como tocadas"];

  return [
    "Elena Girjoaba Music · Resumen del show",
    "",
    `Lista activa: ${nombreModo(estado.configRemota.lista_activa)}`,
    `Pedidos por WhatsApp: ${estado.configRemota.pedidos_whatsapp ? "Activados" : "Desactivados"}`,
    `Cola visible: ${estado.configRemota.mostrar_cola ? "Sí" : "No"}`,
    "",
    `En cola (${cola.length}):`,
    ...lineasCola,
    "",
    `Ya sonaron (${tocadas.length}):`,
    ...lineasTocadas
  ].join("\n");
}

function compartirResumenWhatsapp(numero) {
  const mensaje = encodeURIComponent(construirResumenShow());
  const app = `whatsapp://send?phone=${numero}&text=${mensaje}`;
  const web = `https://wa.me/${numero}?text=${mensaje}`;

  abrirAplicacionConRespaldo(app, web);
}

async function copiarEnlaceShow() {
  const enlace = `${window.location.origin}${window.location.pathname}`;

  try {
    await navigator.clipboard.writeText(enlace);
    DOM.adminEstado.textContent = "Enlace del show copiado.";
  } catch (error) {
    window.prompt("Copia este enlace:", enlace);
  }
}

function exportarDatosShow() {
  const datos = {
    exportado_en: new Date().toISOString(),
    lista_activa: estado.configRemota.lista_activa,
    lista_nombre: nombreModo(estado.configRemota.lista_activa),
    pedidos_whatsapp: estado.configRemota.pedidos_whatsapp,
    mostrar_cola: estado.configRemota.mostrar_cola,
    inicio_show: estado.configRemota.inicio_show,
    cola: estado.configRemota.cola
      .map(obtenerCancion)
      .filter(Boolean)
      .map(({ id, titulo, artista }) => ({ id, titulo, artista })),
    tocadas: estado.configRemota.tocadas
      .map(obtenerCancion)
      .filter(Boolean)
      .map(({ id, titulo, artista }) => ({ id, titulo, artista }))
  };

  const contenido = JSON.stringify(datos, null, 2);
  const archivo = new Blob([contenido], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(archivo);
  const enlace = document.createElement("a");
  const fecha = new Date().toISOString().slice(0, 10);

  enlace.href = url;
  enlace.download = `elena-girjoaba-show-${fecha}.json`;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);

  DOM.adminEstado.textContent = "Datos del show exportados.";
}

function registrarEventos() {
  DOM.seguirInstagram.addEventListener("click", (evento) => {
    evento.preventDefault();

    // Mantener oculto el acceso y mostrarlo únicamente al cumplirse 3 segundos.
    DOM.continuar.hidden = true;
    DOM.entrar.hidden = true;
    DOM.continuar.classList.remove("is-visible");

    guardarVisitaInstagram();
    programarContinuacion();
    abrirInstagram();
  });

  DOM.entrar.addEventListener("click", mostrarApp);

  DOM.mostrarTodo.addEventListener("click", () => {
    estado.mostrar = true;
    estado.categoria = null;
    estado.consulta = "";
    DOM.buscar.value = "";

    DOM.categorias.forEach((boton) =>
      boton.classList.remove("is-active")
    );

    actualizarControles();
    renderizar();

    DOM.lista.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  DOM.categorias.forEach((boton) => {
    boton.addEventListener("click", () => {
      estado.categoria = boton.dataset.categoria;
      estado.mostrar = false;
      estado.consulta = "";
      DOM.buscar.value = "";

      DOM.categorias.forEach((otro) =>
        otro.classList.toggle("is-active", otro === boton)
      );

      actualizarControles();
      renderizar();
    });
  });

  DOM.buscar.addEventListener("input", (evento) => {
    estado.consulta = evento.target.value;
    estado.mostrar = false;

    // Conserva el género activo para buscar dentro de él.
    actualizarControles();
    renderizar();
  });

  DOM.limpiar.addEventListener("click", () => {
    estado.consulta = "";
    DOM.buscar.value = "";
    actualizarControles();
    renderizar();
    DOM.buscar.focus();
  });

  DOM.volver.addEventListener("click", () =>
    DOM.controles.scrollIntoView({ behavior: "smooth", block: "start" })
  );

  $$('a[href*="wa.me"]').forEach((enlace) => {
    enlace.addEventListener("click", (evento) => {
      if (enlace.closest("#pedidoModal")) return;

      evento.preventDefault();

      const mensaje = encodeURIComponent(
        "Hola Elena Girjoaba Music. 👋\n\nMe gustaría cotizar música en vivo para un evento.\n\n¿Podrían darme información sobre disponibilidad y precios?\n\n¡Muchas gracias!"
      );

      abrirAplicacionConRespaldo(
        `whatsapp://send?phone=${telefonoWhatsAppActual()}&text=${mensaje}`,
        `https://wa.me/${telefonoWhatsAppActual()}?text=${mensaje}`
      );
    });
  });

  $$('a[href*="instagram.com"]')
    .filter((enlace) => enlace !== DOM.seguirInstagram)
    .forEach((enlace) => {
      enlace.addEventListener("click", (evento) => {
        evento.preventDefault();
        abrirInstagram();
      });
    });

  const accesosAdmin = [
    DOM.adminTrigger,
    DOM.adminTriggerPortada
  ].filter(Boolean);

  accesosAdmin.forEach((acceso) => {
    let pulsacionActiva = false;
    let idPuntero = null;

    const iniciarAccesoAdmin = (evento) => {
      // En Android evita que la pulsación prolongada seleccione la palabra
      // o abra el menú contextual antes de activar el acceso secreto.
      if (evento.cancelable) evento.preventDefault();
      evento.stopPropagation();

      pulsacionActiva = true;
      idPuntero = evento.pointerId ?? null;

      if (idPuntero !== null && acceso.setPointerCapture) {
        try { acceso.setPointerCapture(idPuntero); } catch (_) {}
      }

      const seleccion = window.getSelection?.();
      if (seleccion && seleccion.rangeCount) seleccion.removeAllRanges();

      iniciarPulsacionAdmin();
    };

    const terminarAccesoAdmin = (evento) => {
      if (!pulsacionActiva) return;
      if (evento?.cancelable) evento.preventDefault();

      pulsacionActiva = false;
      cancelarPulsacionAdmin();

      if (idPuntero !== null && acceso.releasePointerCapture) {
        try { acceso.releasePointerCapture(idPuntero); } catch (_) {}
      }
      idPuntero = null;
    };

    if (window.PointerEvent) {
      acceso.addEventListener("pointerdown", iniciarAccesoAdmin, { passive: false });
      acceso.addEventListener("pointerup", terminarAccesoAdmin, { passive: false });
      acceso.addEventListener("pointercancel", terminarAccesoAdmin, { passive: false });
    } else {
      acceso.addEventListener("touchstart", iniciarAccesoAdmin, { passive: false });
      acceso.addEventListener("touchend", terminarAccesoAdmin, { passive: false });
      acceso.addEventListener("touchcancel", terminarAccesoAdmin, { passive: false });
      acceso.addEventListener("mousedown", iniciarAccesoAdmin);
      acceso.addEventListener("mouseup", terminarAccesoAdmin);
      acceso.addEventListener("mouseleave", terminarAccesoAdmin);
    }

    acceso.addEventListener("selectstart", (evento) => evento.preventDefault());
    acceso.addEventListener("dragstart", (evento) => evento.preventDefault());
    acceso.addEventListener("contextmenu", (evento) => evento.preventDefault());
    acceso.addEventListener("click", (evento) => evento.preventDefault());
  });

  $$("[data-cerrar-admin]").forEach((elemento) =>
    elemento.addEventListener("click", cerrarAdmin)
  );

  DOM.adminIngresar.addEventListener("click", () => {
    if (DOM.adminClave.value === obtenerSeguridadLocal().password) {
      mostrarSelectorAdmin();
    } else {
      DOM.adminError.hidden = false;
    }
  });

  DOM.adminClave.addEventListener("keydown", (evento) => {
    if (evento.key === "Enter") DOM.adminIngresar.click();
  });

  DOM.adminGuardar.addEventListener("click", guardarConfiguracionAdmin);

  document.querySelectorAll("[data-cerrar-letra]").forEach((elemento) => {
    elemento.addEventListener("click", cerrarLetra);
  });

  if (DOM.letraEditar) {
    const iniciar = (evento) => {
      evento.preventDefault();
      clearTimeout(estado.temporizadorEditarLetra);
      estado.temporizadorEditarLetra = setTimeout(activarEdicionLetra, 2000);
    };
    const cancelar = () => clearTimeout(estado.temporizadorEditarLetra);

    DOM.letraEditar.addEventListener("pointerdown", iniciar);
    DOM.letraEditar.addEventListener("pointerup", cancelar);
    DOM.letraEditar.addEventListener("pointerleave", cancelar);
    DOM.letraEditar.addEventListener("pointercancel", cancelar);
  }

  document.querySelectorAll("[data-letra-comando]").forEach((boton) => {
    boton.addEventListener("click", () => {
      ejecutarFormatoLetra(boton.dataset.letraComando, boton.dataset.letraValor || null);
    });
  });

  DOM.letraColorBoton?.addEventListener("click", (evento) => {
    evento.preventDefault();
    evento.stopPropagation();
    alternarMenuLetra(DOM.letraColorMenu, DOM.letraColorBoton);
  });
  DOM.letraTamanoBoton?.addEventListener("click", (evento) => {
    evento.preventDefault();
    evento.stopPropagation();
    alternarMenuLetra(DOM.letraTamanoMenu, DOM.letraTamanoBoton);
  });
  DOM.letraIconosBoton?.addEventListener("click", (evento) => {
    evento.preventDefault();
    evento.stopPropagation();
    alternarMenuLetra(DOM.letraIconosMenu, DOM.letraIconosBoton);
  });

  [DOM.letraColorMenu, DOM.letraTamanoMenu, DOM.letraIconosMenu].forEach((menu) => {
    menu?.addEventListener("click", (evento) => evento.stopPropagation());
  });
  document.addEventListener("click", (evento) => {
    if (!evento.target.closest(".letra-toolbar__desplegable")) ocultarMenusLetra();
  });
  window.addEventListener("resize", () => {
    if (DOM.letraColorMenu?.classList.contains("is-open")) posicionarMenuLetra(DOM.letraColorMenu, DOM.letraColorBoton);
    if (DOM.letraTamanoMenu?.classList.contains("is-open")) posicionarMenuLetra(DOM.letraTamanoMenu, DOM.letraTamanoBoton);
    if (DOM.letraIconosMenu?.classList.contains("is-open")) posicionarMenuLetra(DOM.letraIconosMenu, DOM.letraIconosBoton);
  });

  document.querySelectorAll("[data-letra-color]").forEach((boton) => {
    boton.addEventListener("click", () => {
      const color = boton.dataset.letraColor;
      ejecutarFormatoLetra("foreColor", color);
      DOM.letraColorMuestra.style.background = color;
      ocultarMenusLetra();
    });
  });

  document.querySelectorAll("[data-letra-tamano]").forEach((boton) => {
    boton.addEventListener("click", () => {
      ejecutarFormatoLetra("fontSize", boton.dataset.letraTamano);
      DOM.letraTamanoBoton.textContent = `Tamaño: ${boton.dataset.letraTamanoNombre}`;
      ocultarMenusLetra();
    });
  });

  document.querySelectorAll("[data-letra-icono]").forEach((boton) => {
    boton.addEventListener("click", () => insertarIconoLetra(boton.dataset.letraIcono));
  });

  DOM.letraDeshacer?.addEventListener("click", () => ejecutarFormatoLetra("undo"));
  DOM.letraRehacer?.addEventListener("click", () => ejecutarFormatoLetra("redo"));
  DOM.letraGuardar?.addEventListener("click", guardarLetraEscenario);
  DOM.letraCancelar?.addEventListener("click", cancelarEdicionLetra);

  DOM.adminNuevaCancion?.addEventListener("click", abrirNuevaCancion);
  DOM.adminAgregarLetra?.addEventListener("click", (e) => { e.stopPropagation(); abrirMenuAgregarLetra(); });
  document.querySelectorAll("[data-crear-letra]").forEach((boton) => {
    boton.addEventListener("click", () => abrirAgregarLetra(boton.dataset.crearLetra));
  });
  DOM.agregarLetraCancion?.addEventListener("change", () => {
    DOM.agregarLetraError.hidden = true;
  });
  DOM.agregarLetraGuardar?.addEventListener("click", guardarNuevaLetra);
  DOM.nuevaCancionGuardar?.addEventListener("click", guardarCancionDesdePanel);
  DOM.nuevaCancionCancelar?.addEventListener("click", cerrarNuevaCancion);
  document.querySelectorAll("[data-cerrar-nueva-cancion]").forEach((el) => el.addEventListener("click", cerrarNuevaCancion));
  DOM.agregarLetraCancelar?.addEventListener("click", cerrarAgregarLetra);
  document.querySelectorAll("[data-cerrar-agregar-letra]").forEach((el) => el.addEventListener("click", cerrarAgregarLetra));
  DOM.confirmacionAceptar?.addEventListener("click", () => resolverConfirmacion(true));
  DOM.confirmacionCancelar?.addEventListener("click", () => resolverConfirmacion(false));
  document.querySelectorAll("[data-confirmacion-cancelar]").forEach((el) => el.addEventListener("click", () => resolverConfirmacion(false)));
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".admin-agregar-letra")) DOM.adminAgregarMenu && (DOM.adminAgregarMenu.hidden = true);
  });

  DOM.adminBuscarCancion.addEventListener("input", renderizarListaMaestra);
  DOM.adminFinalizarShow.addEventListener("click", finalizarShow);

  DOM.adminVolverConfiguracion.addEventListener("click", () =>
    mostrarVistaAdmin("configuracion")
  );

  DOM.adminSubir.addEventListener("click", () => {
    DOM.adminBuscarCancion.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
    DOM.adminBuscarCancion.focus();
  });

  DOM.adminMenuBoton.addEventListener("click", () => {
    const abierto = !DOM.adminMenuLateral.hidden;
    DOM.adminMenuLateral.hidden = abierto;
    DOM.adminMenuBoton.setAttribute("aria-expanded", String(!abierto));
  });

  $$("[data-admin-seccion]").forEach((boton) => {
    boton.addEventListener("click", () =>
      mostrarVistaAdmin(boton.dataset.adminSeccion)
    );
  });

  $$("[data-admin-volver]").forEach((boton) => {
    boton.addEventListener("click", () => {
      const destino = estado.configRemota.show_activo
        ? "canciones"
        : "configuracion";
      mostrarVistaAdmin(destino);
    });
  });

  DOM.adminCerrarSesion.addEventListener("click", cerrarAdmin);

  DOM.adminAbrirPublico.addEventListener("click", () => {
    window.open(`${window.location.origin}${window.location.pathname}`, "_blank", "noopener");
  });

  DOM.adminAbrirClientes.addEventListener("click", () => {
    window.open(`${window.location.origin}${window.location.pathname}?lista=todas`, "_blank", "noopener");
  });

  DOM.adminCopiarEnlace.addEventListener("click", copiarEnlaceShow);
  DOM.adminCompartirElena.addEventListener("click", () =>
    compartirResumenWhatsapp(CONFIG.telefonoElena)
  );
  DOM.adminCompartirDaniel.addEventListener("click", () =>
    compartirResumenWhatsapp(CONFIG.telefonoDaniel)
  );
  DOM.adminExportarDatos.addEventListener("click", exportarDatosShow);

  DOM.adminFiltrosContactos.forEach((boton) => {
    boton.addEventListener("click", () => {
      estado.filtroContactos = boton.dataset.contactosFiltro;

      DOM.adminFiltrosContactos.forEach((otro) =>
        otro.classList.toggle("is-active", otro === boton)
      );

      renderizarContactosAdmin();
    });
  });

  DOM.adminCompartirContactosElena.addEventListener("click", () =>
    compartirContactosWhatsapp(CONFIG.telefonoElena)
  );

  DOM.adminCompartirContactosDaniel.addEventListener("click", () =>
    compartirContactosWhatsapp(CONFIG.telefonoDaniel)
  );

  DOM.adminExportarContactos.addEventListener("click", exportarContactos);

  $$("[data-cerrar-pedido]").forEach((elemento) =>
    elemento.addEventListener("click", cerrarPedido)
  );

  DOM.pedidoEnviar.addEventListener("click", enviarPedidoWhatsApp);

  $$("[data-cerrar-notas]").forEach((elemento) =>
    elemento.addEventListener("click", cerrarNotas)
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") programarContinuacion();
  });

  window.addEventListener("pageshow", programarContinuacion);
  window.addEventListener("resize", actualizarPosicionMenuPublico);
  window.addEventListener("orientationchange", () => {
    window.setTimeout(actualizarPosicionMenuPublico, 150);
  });

  if ("ResizeObserver" in window && DOM.estadoShowPublico) {
    const observadorColaPublica = new ResizeObserver(() => {
      actualizarPosicionMenuPublico();
    });

    observadorColaPublica.observe(DOM.estadoShowPublico);
  }
}

async function iniciar() {
  capturarDOM();
  const panelMode=new URLSearchParams(location.search).get("panel")==="1";
  if(panelMode){
    sessionStorage.setItem("egm-panel-auth","1");
    DOM.landing.hidden=true;DOM.app.hidden=false;
    if(DOM.panelBackButton){DOM.panelBackButton.hidden=false;DOM.panelBackButton.addEventListener("click",()=>{location.href="panel.html?trusted=1&live=1";});}
  }
  await cargarLetras();

  DOM.anio.textContent = String(new Date().getFullYear());
  DOM.continuar.hidden = true;
  DOM.entrar.hidden = true;
  DOM.volver.hidden = true;

  registrarEventos();
  programarContinuacion();
  cargarIndiceAnotaciones();

  try {
    await cargarDatos();
    if (CATALOGO_PUBLICO) {
      DOM.landing.hidden = true;
      DOM.app.hidden = false;
      DOM.volver.hidden = true;
      estado.modo = "todas";
      estado.modoForzado = true;
      estado.vistaClientes = true;
      aplicarModo("todas", false);
      estado.mostrar = true;
      actualizarControles();
      renderizar();
      renderizarEstadoPublico();
    } else if(panelMode){DOM.landing.hidden=true;DOM.app.hidden=false;estado.mostrar=true;renderizar();}
  } catch (error) {
    console.error(error);
    DOM.errorCarga.hidden = false;
    DOM.contador.textContent = "";
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", iniciar, { once: true });
} else {
  iniciar();
}
