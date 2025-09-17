import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js';
import { PLYLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/PLYLoader.js';
import { RoomEnvironment } from 'https://unpkg.com/three@0.164.1/examples/jsm/environments/RoomEnvironment.js';
import { LineSegments2 } from 'https://unpkg.com/three@0.164.1/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'https://unpkg.com/three@0.164.1/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'https://unpkg.com/three@0.164.1/examples/jsm/lines/LineMaterial.js';

// Group registry for synchronized viewers
const __viewerGroups = new Map(); // groupId -> Set<PLYModelViewer>

// Default class palette (RGB floats 0..1)
const DEFAULT_CLASS_COLOR_MAP = {
  cabinet: [0.12156862745098039, 0.4666666666666667, 0.7058823529411765],
  bed: [1.0, 0.7333333333333333, 0.47058823529411764],
  chair: [0.7372549019607844, 0.7411764705882353, 0.13333333333333333],
  sofa: [0.5490196078431373, 0.33725490196078434, 0.29411764705882354],
  table: [1.0, 0.596078431372549, 0.5882352941176471],
  door: [0.8392156862745098, 0.15294117647058825, 0.1568627450980392],
  window: [0.7725490196078432, 0.6901960784313725, 0.8352941176470589],
  bookshelf: [0.5803921568627451, 0.403921568627451, 0.7411764705882353],
  picture: [0.7686274509803922, 0.611764705882353, 0.5803921568627451],
  counter: [0.09019607843137255, 0.7450980392156863, 0.8117647058823529],
  desk: [0.9686274509803922, 0.7137254901960784, 0.8235294117647058],
  curtain: [0.8588235294117647, 0.8588235294117647, 0.5529411764705883],
  refrigerator: [1.0, 0.4980392156862745, 0.054901960784313725],
  showercurtrain: [0.6196078431372549, 0.8549019607843137, 0.8980392156862745],
  toilet: [0.17254901960784313, 0.6274509803921569, 0.17254901960784313],
  sink: [0.4392156862745098, 0.5019607843137255, 0.5647058823529412],
  bathtub: [0.8901960784313725, 0.4666666666666667, 0.7607843137254902],
  garbagebin: [0.3215686274509804, 0.32941176470588235, 0.6392156862745098],
  "": [0.08627450980392157, 0.8, 0.9607843137254902]
};

// Default class order for numeric ids
const DEFAULT_CLASS_ORDER = [
  'cabinet', 'bed', 'chair', 'sofa', 'table', 'door', 'window', 'bookshelf', 'picture', 'counter', 'desk', 'curtain', 'refrigerator', 'showercurtrain', 'toilet', 'sink', 'bathtub', 'garbagebin', ''
];

export class PLYModelViewer {
  constructor(options = {}) {
    this.options = {
      width: options.width ?? 640,
      height: options.height ?? 480,
      background: options.background ?? '#111418',
      grid: options.grid ?? false,
      axes: options.axes ?? false,
      showAnnotations: options.showAnnotations ?? true,
      groupId: options.groupId ?? null,
      renderMode: options.renderMode ?? 'auto', // 'auto' | 'mesh' | 'points'
      pointSize: options.pointSize ?? null, // world units; if null, auto from bbox
      bboxLineWidthPx: options.bboxLineWidthPx ?? 3
    };

    this.root = document.createElement('div');
    this.root.className = 'ply-model-viewer';
    Object.assign(this.root.style, {
      position: 'relative',
      width: typeof this.options.width === 'number' ? `${this.options.width}px` : this.options.width,
      height: typeof this.options.height === 'number' ? `${this.options.height}px` : this.options.height,
      background: this.options.background,
      borderRadius: '8px',
      overflow: 'hidden',
      border: '1px solid #222',
      boxSizing: 'border-box'
    });

    this.videoElement = null;
    this.videoPoses = null;
    this.videoSyncEnabled = false;
    this._onVideoTimeUpdate = null;
    this.videoFps = null;
    this._rvfcId = null;
    this._rvfcLoop = null;
    this._suppressSyncBroadcast = false;

    this._intrinsics = null; // { K:[[...]], W, H }

    this._createScene();
    this._createUI();
    this._bindResize();

    this.groupId = this.options.groupId;
    this._suppressBroadcast = false;
    this._registerToGroup();
  }

  _createScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.options.background);

    const initialWidth = 640;
    const initialHeight = 480;
    this.camera = new THREE.PerspectiveCamera(60, initialWidth / initialHeight, 0.01, 1000);
    this.camera.position.set(2, 2, 2);
    this.camera.up.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(initialWidth, initialHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.useLegacyLights = false;
    this.root.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });

    this._pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment(this.renderer);
    this._pmremRT = this._pmremGenerator.fromScene(envScene, 0.04);
    this.scene.environment = this._pmremRT.texture;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.dollyToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.95;
    this.controls.zoomSpeed = 1.0;
    this.controls.panSpeed = 0.9;
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = Infinity;
    this._onControlsChange = () => this._handleControlsChange();
    this.controls.addEventListener('change', this._onControlsChange);
    // Disable video sync when user starts interacting with the camera
    this._onControlsStart = () => this._handleUserInteractionStart();
    this._onControlsEnd = () => this._handleUserInteractionEnd();
    this.controls.addEventListener('start', this._onControlsStart);
    this.controls.addEventListener('end', this._onControlsEnd);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.8);
    this.scene.add(hemi);
    this.cameraDirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    this.cameraDirLight.position.copy(this.camera.position);
    this.scene.add(this.cameraDirLight);
    this.cameraDirLightTarget = new THREE.Object3D();
    this.scene.add(this.cameraDirLightTarget);
    this.cameraDirLight.target = this.cameraDirLightTarget;

    this.contentGroup = new THREE.Group();
    this.scene.add(this.contentGroup);

    this.modelGroup = new THREE.Group();
    this.contentGroup.add(this.modelGroup);

    this.bboxesGroup = new THREE.Group();
    this.bboxesGroup.visible = this.options.showAnnotations;
    this.contentGroup.add(this.bboxesGroup);

    if (this.options.grid) {
      const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
      this.scene.add(grid);
    }
    if (this.options.axes) {
      const axes = new THREE.AxesHelper(1);
      this.scene.add(axes);
    }

    this._animate = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animate);
  }

  _animate() {
    this.controls.update();
    this._updateCameraLight();
    this.renderer.render(this.scene, this.camera);
  }

  _createUI() {
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    Object.assign(bar.style, {
      position: 'absolute',
      top: '8px',
      left: '8px',
      display: 'flex',
      gap: '12px',
      alignItems: 'center',
      background: 'rgba(0,0,0,0.45)',
      color: '#f0f0f0',
      padding: '6px 10px',
      borderRadius: '6px',
      backdropFilter: 'blur(4px)',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif',
      fontSize: '13px'
    });

    const id1 = `bbox-toggle-${Math.random().toString(36).slice(2)}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = id1;
    checkbox.checked = this.options.showAnnotations;
    checkbox.addEventListener('change', () => {
      this.setBBoxesVisible(checkbox.checked);
    });

    const label = document.createElement('label');
    label.htmlFor = id1;
    label.textContent = 'Show annotations';

    const id2 = `sync-toggle-${Math.random().toString(36).slice(2)}`;
    const syncCheckbox = document.createElement('input');
    syncCheckbox.type = 'checkbox';
    syncCheckbox.id = id2;
    syncCheckbox.checked = this.videoSyncEnabled;
    syncCheckbox.addEventListener('change', () => {
      this.setSyncWithVideoEnabled(syncCheckbox.checked);
    });

    const syncLabel = document.createElement('label');
    syncLabel.htmlFor = id2;
    syncLabel.textContent = 'Sync with video';

    bar.appendChild(checkbox);
    bar.appendChild(label);
    bar.appendChild(syncCheckbox);
    bar.appendChild(syncLabel);
    this.root.appendChild(bar);

    this.ui = { bar, checkbox, label, syncCheckbox, syncLabel };
  }

  _bindResize() {
    const ro = new ResizeObserver(() => this._handleResize());
    ro.observe(this.root);
    this.resizeObserver = ro;
    this._handleResizeBound = () => this._handleResize();
    window.addEventListener('resize', this._handleResizeBound);
  }

  _handleResize() {
    const width = this.root.clientWidth || (typeof this.options.width === 'number' ? this.options.width : 640);
    const height = this.root.clientHeight || (typeof this.options.height === 'number' ? this.options.height : 480);
    if (width && height) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      if (this._intrinsics) this._applyIntrinsics(this._intrinsics.K, this._intrinsics.W, this._intrinsics.H);
      this._updateLineResolutions();
    }
  }

  async loadModel(plyUrl, materialOptions = {}) {
    const loader = new PLYLoader();
    const geometry = await new Promise((resolve, reject) => {
      loader.load(plyUrl, resolve, undefined, reject);
    });

    const hasFaces = !!geometry.index;
    const mode = this.options.renderMode;
    const renderAsPoints = mode === 'points' || (mode === 'auto' && !hasFaces);

    let object3D;
    if (renderAsPoints) {
      const hasColors = !!geometry.getAttribute('color');
      const pointSize = this._getAutoPointSize(geometry);
      const pointsMat = new THREE.PointsMaterial({
        size: this.options.pointSize ?? pointSize,
        sizeAttenuation: true,
        vertexColors: hasColors,
        color: hasColors ? undefined : 0x9aa4b2
      });
      object3D = new THREE.Points(geometry, pointsMat);
    } else {
      if (!geometry.getAttribute('normal') && hasFaces) {
        geometry.computeVertexNormals();
      }
      let material;
      if (geometry.getAttribute('color')) {
        material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.0, side: THREE.DoubleSide, ...materialOptions });
      } else {
        material = new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, ...materialOptions });
      }
      object3D = new THREE.Mesh(geometry, material);
      object3D.castShadow = false;
      object3D.receiveShadow = false;
    }

    this.modelGroup.clear();
    this.modelGroup.add(object3D);

    this._fitViewToObject(object3D);

    return object3D;
  }

  setAnnotations(annotations, options = {}) {
    this.bboxesGroup.clear();
    this._classToColor = this._classToColor || new Map();

    const colorFn = options.colorForClass || ((cls) => {
      if (!this._classToColor.has(cls)) {
        const color = this._nextDistinctColor(this._classToColor.size);
        this._classToColor.set(cls, color);
      }
      return this._classToColor.get(cls);
    });

    const size = new THREE.Vector2();
    this.renderer.getSize(size);

    for (const item of annotations || []) {
      if (!Array.isArray(item) || item.length < 7) continue;
      const [x, y, z, h, w, l, classNameRaw] = item;
      const className = typeof classNameRaw === 'number' ? (DEFAULT_CLASS_ORDER[classNameRaw] ?? String(classNameRaw)) : String(classNameRaw);

      const boxGeom = new THREE.BoxGeometry(Number(w), Number(h), Number(l));
      const edgesGeom = new THREE.EdgesGeometry(boxGeom);

      const positions = edgesGeom.attributes.position.array;
      const segGeom = new LineSegmentsGeometry();
      segGeom.setPositions(positions);

      const mappedColor = this._getMappedColorForClass(className);
      const fallbackColor = colorFn(className);
      const lineMat = new LineMaterial({ color: mappedColor ?? fallbackColor, linewidth: this.options.bboxLineWidthPx, transparent: true, opacity: 0.95 });
      lineMat.resolution.set(size.x, size.y);

      const edges = new LineSegments2(segGeom, lineMat);
      edges.position.set(Number(x), Number(y), Number(z));

      edges.userData.className = className;
      this.bboxesGroup.add(edges);

      boxGeom.dispose();
      edgesGeom.dispose();
    }

    this.setBBoxesVisible(this.ui?.checkbox?.checked ?? this.options.showAnnotations);
  }

  setBBoxesVisible(visible) {
    this.bboxesGroup.visible = !!visible;
    if (this.ui?.checkbox) this.ui.checkbox.checked = !!visible;
  }

  setBackground(color) {
    this.options.background = color;
    if (this.scene) this.scene.background = new THREE.Color(color);
    if (this.root) this.root.style.background = color;
  }

  setSyncWithVideoEnabled(enabled, suppress = false) {
    this.videoSyncEnabled = !!enabled;
    if (this.ui?.syncCheckbox) this.ui.syncCheckbox.checked = this.videoSyncEnabled;
    if (this.videoSyncEnabled) this._updateFromVideoTime();
    if (!suppress) this._broadcastVideoSyncState();
  }

  attachVideoSync(videoElement, poses, fps) {
    this.detachVideoSync();
    this.videoElement = videoElement || null;
    this.videoPoses = Array.isArray(poses) ? poses : null;
    this.videoFps = typeof fps === 'number' && isFinite(fps) ? fps : null;
    if (!this.videoElement || !this.videoPoses || this.videoPoses.length === 0) return;

    this._onVideoTimeUpdate = () => this._updateFromVideoTime();
    this.videoElement.addEventListener('timeupdate', this._onVideoTimeUpdate);
    this.videoElement.addEventListener('seeked', this._onVideoTimeUpdate);
    this.videoElement.addEventListener('loadedmetadata', this._onVideoTimeUpdate);
    this.videoElement.addEventListener('play', this._onVideoTimeUpdate);
    this.videoElement.addEventListener('ended', this._onVideoTimeUpdate);

    // Prefer per-frame syncing when supported
    if (typeof this.videoElement.requestVideoFrameCallback === 'function') {
      this._rvfcLoop = (_now, metadata) => {
        if (!this.videoSyncEnabled || !this.videoPoses) {
          // keep scheduling to re-enter when enabled
          this._rvfcId = this.videoElement.requestVideoFrameCallback(this._rvfcLoop);
          return;
        }
        const n = this.videoPoses.length;
        const dur = this.videoElement.duration;
        const mediaTime = typeof metadata?.mediaTime === 'number' ? metadata.mediaTime : this.videoElement.currentTime;
        if (n > 0 && dur && isFinite(dur) && dur > 0) {
          const idx = Math.max(0, Math.min(n - 1, Math.round((mediaTime / dur) * (n - 1))));
          const pose = this.videoPoses[idx] || null;
          if (pose) this._applyRTMatrix(pose);
        } else {
          this._updateFromVideoTime();
        }
        this._rvfcId = this.videoElement.requestVideoFrameCallback(this._rvfcLoop);
      };
      this._rvfcId = this.videoElement.requestVideoFrameCallback(this._rvfcLoop);
    }

    if (this.videoSyncEnabled) this._updateFromVideoTime();
  }

  detachVideoSync() {
    if (this.videoElement && this._onVideoTimeUpdate) {
      this.videoElement.removeEventListener('timeupdate', this._onVideoTimeUpdate);
      this.videoElement.removeEventListener('seeked', this._onVideoTimeUpdate);
      this.videoElement.removeEventListener('loadedmetadata', this._onVideoTimeUpdate);
      this.videoElement.removeEventListener('play', this._onVideoTimeUpdate);
      this.videoElement.removeEventListener('ended', this._onVideoTimeUpdate);
    }
    if (this.videoElement && typeof this.videoElement.cancelVideoFrameCallback === 'function' && this._rvfcId !== null) {
      try { this.videoElement.cancelVideoFrameCallback(this._rvfcId); } catch (_) {}
    }
    this._rvfcId = null;
    this._rvfcLoop = null;
    this._onVideoTimeUpdate = null;
    this.videoElement = null;
    this.videoPoses = null;
    this.videoFps = null;
  }

  _updateFromVideoTime() {
    if (!this.videoSyncEnabled || !this.videoElement || !this.videoPoses) return;
    const n = this.videoPoses.length;

    // If FPS known, select by current frame index; else fall back to time ratio
    let idx = null;
    if (this.videoFps && isFinite(this.videoFps) && this.videoFps > 0) {
      const currentFrame = Math.round(this.videoElement.currentTime * this.videoFps);
      idx = Math.max(0, Math.min(n - 1, currentFrame));
    } else if (this.videoElement.duration && isFinite(this.videoElement.duration) && this.videoElement.duration > 0) {
      const t = this.videoElement.currentTime;
      const dur = this.videoElement.duration;
      idx = Math.max(0, Math.min(n - 1, Math.round((t / dur) * (n - 1))));
    }

    if (idx !== null) {
      const pose = this.videoPoses[idx];
      if (pose) this._applyRTMatrix(pose);
    }
  }

  _applyRTMatrix(rt) {
    // Accept formats: 3x4, 4x4, flat 12/16, or nested arrays
    let m;
    if (Array.isArray(rt)) {
      if (Array.isArray(rt[0])) {
        // nested
        const rows = rt.length;
        const cols = rt[0].length;
        m = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) m.push(Number(rt[r][c]));
        }
      } else {
        m = rt.map(Number);
      }
    } else {
      return;
    }
    // Normalize to 3x4 (row-major) extrinsic [R|t]
    if (m.length === 16) {
      // assume row-major 4x4
      // take top 3 rows
      m = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]];
    }
    if (m.length !== 12) return;
    const R = [
      [m[0], m[1], m[2]],
      [m[4], m[5], m[6]],
      [m[8], m[9], m[10]]
    ];
    const t = new THREE.Vector3(m[3], m[7], m[11]);

    // Camera-to-world: inverse of [R|t]
    const Rt = new THREE.Matrix3();
    Rt.set(
      R[0][0], R[1][0], R[2][0],
      R[0][1], R[1][1], R[2][1],
      R[0][2], R[1][2], R[2][2]
    );
    const position = new THREE.Vector3();
    // position = -R^T * t
    position.copy(t).applyMatrix3(Rt).multiplyScalar(-1);

    const rotM4 = new THREE.Matrix4();
    rotM4.set(
      Rt.elements[0], Rt.elements[3], Rt.elements[6], 0,
      Rt.elements[1], Rt.elements[4], Rt.elements[7], 0,
      Rt.elements[2], Rt.elements[5], Rt.elements[8], 0,
      0, 0, 0, 1
    );
    const q = new THREE.Quaternion().setFromRotationMatrix(rotM4);

    // Derive a reasonable target from forward vector and current distance
    const currentTarget = this.controls ? this.controls.target.clone() : new THREE.Vector3(0, 0, 0);
    const currentDistance = this.camera.position.distanceTo(currentTarget) || 1.0;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const newTarget = position.clone().add(forward.multiplyScalar(currentDistance));

    // Apply without triggering broadcast loops and sync OrbitControls state
    this._suppressBroadcast = true;
    this.camera.position.copy(position);
    this.camera.quaternion.copy(q);
    if (this.controls) {
      this.controls.target.copy(newTarget);
      // Sync internal spherical with new offset so update() won't override
      const offset = this.camera.position.clone().sub(this.controls.target);
      if (this.controls.spherical && typeof this.controls.spherical.setFromVector3 === 'function') {
        this.controls.spherical.setFromVector3(offset);
      }
      this.controls.update();
    } else {
      this.camera.lookAt(newTarget);
    }
    this.camera.updateMatrixWorld();
    this._suppressBroadcast = false;
  }

  _broadcastVideoSyncState() {
    if (!this.groupId) return;
    const group = __viewerGroups.get(this.groupId);
    if (!group) return;
    for (const other of group) {
      if (other === this) continue;
      other.setSyncWithVideoEnabled(this.videoSyncEnabled, true);
    }
  }

  getElement() {
    setTimeout(() => { this._handleResize(); this._updateLineResolutions(); }, 0);
    return this.root;
  }

  dispose() {
    this.renderer?.setAnimationLoop(null);
    if (this.controls && this._onControlsChange) this.controls.removeEventListener('change', this._onControlsChange);
    if (this.controls && this._onControlsStart) this.controls.removeEventListener('start', this._onControlsStart);
    if (this.controls && this._onControlsEnd) this.controls.removeEventListener('end', this._onControlsEnd);
    this.controls?.dispose();
    this.resizeObserver?.disconnect();
    if (this._handleResizeBound) window.removeEventListener('resize', this._handleResizeBound);
    this.detachVideoSync();
    this._disposeObject3D(this.scene);
    if (this._pmremRT) this._pmremRT.dispose();
    if (this._pmremGenerator) this._pmremGenerator.dispose();
    this.renderer?.dispose?.();
    this._unregisterFromGroup();
    this.root?.remove();
  }

  _disposeObject3D(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
  }

  _applyIntrinsics(K, sourceW, sourceH) {
    if (!K || !sourceW || !sourceH) return;
    const k = Array.isArray(K[0]) ? [K[0][0], K[0][1] || 0, K[0][2], K[1][0] || 0, K[1][1], K[1][2], K[2][0] || 0, K[2][1] || 0, K[2][2]] : K.slice(0, 9);
    const fx = Number(k[0]);
    const fy = Number(k[4]);
    const cx = Number(k[2]);
    const cy = Number(k[5]);
    if (!isFinite(fx) || !isFinite(fy) || fx <= 0 || fy <= 0) return;

    // Compute vertical FOV from fy and source image height
    const fovY = (2 * Math.atan((sourceH * 0.5) / fy)) * (180 / Math.PI);
    this.camera.fov = fovY;
    const width = this.root.clientWidth || 1;
    const height = this.root.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Apply principal point as view offset
    const offsetX = Math.round(sourceW * 0.5 - cx);
    const offsetY = Math.round(sourceH * 0.5 - cy);
    this.camera.setViewOffset(sourceW, sourceH, offsetX, offsetY, sourceW, sourceH);
    this.camera.updateProjectionMatrix();
  }

  setPinholeIntrinsics(K, sourceW, sourceH) {
    this._intrinsics = { K, W: sourceW, H: sourceH };
    this._applyIntrinsics(K, sourceW, sourceH);
  }

  clearPinholeIntrinsics() {
    this._intrinsics = null;
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  _fitViewToObject(object3D) {
    const box = new THREE.Box3().setFromObject(object3D);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / (2 * Math.tan(fov / 2)));
    cameraZ *= 1.4;

    this.camera.near = Math.max(0.01, cameraZ / 100);
    this.camera.far = Math.max(1000, cameraZ * 100);
    this.camera.updateProjectionMatrix();

    this.camera.up.set(0, 0, 1);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(cameraZ, cameraZ, cameraZ));
    this.camera.lookAt(center);
    this.controls.update();
  }

  _nextDistinctColor(index) {
    const palette = [
      '#ff6b6b', '#feca57', '#54a0ff', '#5f27cd', '#1dd1a1',
      '#ee5253', '#ff9f43', '#48dbfb', '#341f97', '#10ac84',
      '#f368e0', '#ff6b81', '#2e86de', '#576574', '#00d2d3'
    ];
    if (index < palette.length) return palette[index];
    const hue = (index * 137.508) % 360;
    const s = 65;
    const l = 55;
    return this._hslToHex(hue, s, l);
  }

  _hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  }

  _rgbFloatsToHex(rgb) {
    if (!rgb || rgb.length < 3) return null;
    const toHex = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
    return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
  }

  _getMappedColorForClass(className) {
    const rgb = DEFAULT_CLASS_COLOR_MAP[className];
    return rgb ? this._rgbFloatsToHex(rgb) : null;
  }

  _updateCameraLight() {
    if (!this.cameraDirLight || !this.cameraDirLightTarget) return;
    this.cameraDirLight.position.copy(this.camera.position);
    const target = this.controls ? this.controls.target : new THREE.Vector3(0, 0, 0);
    this.cameraDirLightTarget.position.copy(target);
  }

  _handleControlsChange() {
    this._broadcastCameraPose();
  }

  _handleUserInteractionStart() {
    // If user starts interacting, disable sync with video and uncheck checkbox
    if (this.videoSyncEnabled) {
      this.setSyncWithVideoEnabled(false);
    }
  }

  _handleUserInteractionEnd() {
    // No-op for now; could be used to re-enable hints, etc.
  }

  _broadcastCameraPose() {
    if (!this.groupId || this._suppressBroadcast) return;
    const group = __viewerGroups.get(this.groupId);
    if (!group) return;
    for (const other of group) {
      if (other === this) continue;
      other._applyCameraFrom(this);
    }
  }

  _applyCameraFrom(sourceViewer) {
    if (!sourceViewer || !sourceViewer.camera || !this.camera) return;
    this._suppressBroadcast = true;
    this.camera.fov = sourceViewer.camera.fov;
    this.camera.up.copy(sourceViewer.camera.up);
    this.camera.position.copy(sourceViewer.camera.position);
    this.camera.quaternion.copy(sourceViewer.camera.quaternion);
    this.camera.zoom = sourceViewer.camera.zoom;
    this.camera.updateProjectionMatrix();
    if (this.controls && sourceViewer.controls) {
      this.controls.target.copy(sourceViewer.controls.target);
      this.controls.update();
    }
    this._suppressBroadcast = false;
  }

  _registerToGroup() {
    if (!this.groupId) return;
    let set = __viewerGroups.get(this.groupId);
    if (!set) {
      set = new Set();
      __viewerGroups.set(this.groupId, set);
    }
    set.add(this);
  }

  _unregisterFromGroup() {
    if (!this.groupId) return;
    const set = __viewerGroups.get(this.groupId);
    if (set) {
      set.delete(this);
    }
  }

  _getAutoPointSize(geometry) {
    try {
      const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
      const size = new THREE.Vector3();
      box.getSize(size);
      const diag = Math.sqrt(size.x * size.x + size.y * size.y + size.z * size.z);
      const computed = diag * 0.004;
      return Math.max(computed, 0.001);
    } catch (e) {
      return 0.01;
    }
  }

  _updateLineResolutions() {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    this.bboxesGroup.traverse((obj) => {
      const mat = obj?.material;
      if (mat && (mat.isLineMaterial || mat.type === 'LineMaterial') && mat.resolution) {
        mat.resolution.set(size.x, size.y);
      }
    });
  }
}

export async function createPLYViewer(plyUrl, annotations = [], options = {}, groupId, title) {
  const finalOptions = groupId !== undefined && groupId !== null ? { ...options, groupId } : { ...options };
  const viewer = new PLYModelViewer(finalOptions);
  await viewer.loadModel(plyUrl);
  if (annotations && annotations.length) {
    viewer.setAnnotations(annotations);
  }
  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    width: '100%',
    height: '100%',
    display: 'grid',
    gridTemplateRows: 'auto 1fr',
    gap: '6px'
  });
  if (title) {
    const label = document.createElement('div');
    label.textContent = title;
    Object.assign(label.style, {
      fontSize: '14px',
      fontWeight: '600',
      color: '#333',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif',
      textAlign: 'center'
    });
    wrapper.appendChild(label);
  }
  wrapper.appendChild(viewer.getElement());
  wrapper.__viewer = viewer;
  return wrapper;
}

export async function loadAnnotationsFromJson(jsonUrl, options = {}) {
  const { labelAsName = false } = options;
  const res = await fetch(jsonUrl);
  if (!res.ok) throw new Error(`Failed to load annotations json: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const out = [];
  const instances = Array.isArray(data?.instances) ? data.instances : [];
  for (const inst of instances) {
    const b = inst?.bbox_3d;
    if (Array.isArray(b) && b.length >= 6) {
      const raw = inst?.bbox_label_3d;
      const label = labelAsName
        ? (typeof raw === 'number' ? (DEFAULT_CLASS_ORDER[raw] ?? String(raw)) : String(raw))
        : raw;
      out.push([Number(b[0]), Number(b[1]), Number(b[2]), Number(b[4]), Number(b[3]), Number(b[5]), label]);
    }
  }
  return out;
}

export async function loadPosesFromTxt(txtUrl, options = {}) {
  const { format = 'extrinsic' } = options; // 'blender' | 'extrinsic'
  const res = await fetch(txtUrl);
  if (!res.ok) throw new Error(`Failed to load poses: ${res.status} ${res.statusText}`);
  const text = await res.text();

  // Try JSON first
  let asJson = null;
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) asJson = data;
  } catch (_) {}

  // Plain text parsing helpers (fallback)
  const numRegex = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  const lines = text.split(/\r?\n/);

  const blocks = [];
  if (!asJson) {
    let current = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        if (current.length) { blocks.push(current.slice()); current = []; }
        continue;
      }
      const nums = (trimmed.match(numRegex) || []).map(parseFloat);
      if (nums.length > 0) current.push(nums);
    }
    if (current.length) blocks.push(current);
  }

  const rawPoses = [];

  const pushFlat = (arr) => {
    if (arr.length === 12) {
      rawPoses.push({ type: '3x4', data: [
        [arr[0], arr[1], arr[2], arr[3]],
        [arr[4], arr[5], arr[6], arr[7]],
        [arr[8], arr[9], arr[10], arr[11]]
      ]});
      return true;
    }
    if (arr.length === 16) {
      rawPoses.push({ type: '4x4', data: [
        [arr[0], arr[1], arr[2], arr[3]],
        [arr[4], arr[5], arr[6], arr[7]],
        [arr[8], arr[9], arr[10], arr[11]],
        [arr[12], arr[13], arr[14], arr[15]]
      ]});
      return true;
    }
    return false;
  };

  if (asJson) {
    for (const item of asJson) {
      if (Array.isArray(item)) {
        if (Array.isArray(item[0])) {
          // nested rows
          if (item.length === 3 && item[0].length === 4) rawPoses.push({ type: '3x4', data: item });
          else if (item.length === 4 && item[0].length === 4) rawPoses.push({ type: '4x4', data: item });
          else pushFlat(item.flat());
        } else {
          pushFlat(item.map(Number));
        }
      }
    }
  } else {
    // Parse by blocks first
    for (const blk of blocks) {
      const flat = blk.flat();
      if (pushFlat(flat)) continue;
      if (blk.length === 3 && blk.every(r => r.length === 4)) { rawPoses.push({ type: '3x4', data: blk }); continue; }
      if (blk.length === 4 && blk.every(r => r.length === 4)) { rawPoses.push({ type: '4x4', data: blk }); continue; }
    }
    // If still empty, try per-line poses
    if (rawPoses.length === 0) {
      for (const line of lines) {
        const nums = (line.match(numRegex) || []).map(parseFloat);
        if (pushFlat(nums)) continue;
      }
    }
  }

  if (rawPoses.length === 0) throw new Error('Unrecognized poses.txt format');

  // Convert to extrinsic 3x4 row-major for _applyRTMatrix
  const toExtrinsic3x4 = (mat, type) => {
    // If data are Blender camera world matrices (camera->world): [Rcw|Tcw]
    // Convert to world->camera: [R|t] with R = Rcw^T, t = -Rcw^T * Tcw
    // If already extrinsic, pass through
    const as3x4 = (rows4) => [ rows4[0].slice(0,4), rows4[1].slice(0,4), rows4[2].slice(0,4) ];
    if (format === 'blender') {
      if (type === '4x4') {
        const Rcw = [
          [mat[0][0], mat[0][1], mat[0][2]],
          [mat[1][0], mat[1][1], mat[1][2]],
          [mat[2][0], mat[2][1], mat[2][2]]
        ];
        const Tcw = new THREE.Vector3(mat[0][3], mat[1][3], mat[2][3]);
        const Rt = new THREE.Matrix3();
        Rt.set(
          Rcw[0][0], Rcw[1][0], Rcw[2][0],
          Rcw[0][1], Rcw[1][1], Rcw[2][1],
          Rcw[0][2], Rcw[1][2], Rcw[2][2]
        );
        const t_cam = Tcw.clone().applyMatrix3(Rt).multiplyScalar(-1);
        // R = Rcw^T
        const R = Rt;
        return [
          [R.elements[0], R.elements[3], R.elements[6], t_cam.x],
          [R.elements[1], R.elements[4], R.elements[7], t_cam.y],
          [R.elements[2], R.elements[5], R.elements[8], t_cam.z]
        ];
      }
      if (type === '3x4') {
        const Rcw = [
          [mat[0][0], mat[0][1], mat[0][2]],
          [mat[1][0], mat[1][1], mat[1][2]],
          [mat[2][0], mat[2][1], mat[2][2]]
        ];
        const Tcw = new THREE.Vector3(mat[0][3], mat[1][3], mat[2][3]);
        const Rt = new THREE.Matrix3();
        Rt.set(
          Rcw[0][0], Rcw[1][0], Rcw[2][0],
          Rcw[0][1], Rcw[1][1], Rcw[2][1],
          Rcw[0][2], Rcw[1][2], Rcw[2][2]
        );
        const t_cam = Tcw.clone().applyMatrix3(Rt).multiplyScalar(-1);
        const R = Rt;
        return [
          [R.elements[0], R.elements[3], R.elements[6], t_cam.x],
          [R.elements[1], R.elements[4], R.elements[7], t_cam.y],
          [R.elements[2], R.elements[5], R.elements[8], t_cam.z]
        ];
      }
    } else {
      // format === 'extrinsic'
      if (type === '4x4') return as3x4(mat);
      if (type === '3x4') return mat;
    }
    // Fallback: flatten row-wise into 3x4
    const flat = mat.flat();
    return [
      [flat[0], flat[1], flat[2], flat[3]],
      [flat[4], flat[5], flat[6], flat[7]],
      [flat[8], flat[9], flat[10], flat[11]]
    ];
  };

  const extr3x4 = rawPoses.map(({ type, data }) => toExtrinsic3x4(data, type));
  return extr3x4;
}

export async function loadIntrinsicsFromTxt(txtUrl) {
  const res = await fetch(txtUrl);
  if (!res.ok) throw new Error(`Failed to load intrinsics: ${res.status} ${res.statusText}`);
  const text = await res.text();

  // Try JSON first
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      if (Array.isArray(data[0])) {
        // nested 3x3
        return data;
      }
      // flat array
      if (data.length >= 9) {
        return [
          [Number(data[0]), Number(data[1]), Number(data[2])],
          [Number(data[3]), Number(data[4]), Number(data[5])],
          [Number(data[6]), Number(data[7]), Number(data[8])]
        ];
      }
    }
  } catch (_) {}

  // Plain text: collect numbers
  const numRegex = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  const nums = (text.match(numRegex) || []).map(parseFloat);
  if (nums.length >= 9) {
    return [
      [nums[0], nums[1], nums[2]],
      [nums[3], nums[4], nums[5]],
      [nums[6], nums[7], nums[8]]
    ];
  }
  throw new Error('Unrecognized intrinsics.txt format');
} 