// ============================================================
// AEminiToAE for After Effects  v1.1
// タイムライン動画エディタ ↔ After Effects 双方向ブリッジ
//
// 使い方:
//   AE メニュー → ファイル → スクリプト → スクリプトを実行...
//   この .jsx ファイルを選択してください
// ============================================================

#target aftereffects
#targetengine main

(function tlvBridge(thisObj) {

  // ─── JSON polyfill ────────────────────────────────────────────────────────
  if (typeof JSON === 'undefined') { JSON = {}; }
  if (typeof JSON.stringify !== 'function') {
    JSON.stringify = function (v) {
      if (v === null) return 'null';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
      if (typeof v === 'string') {
        return '"' + v.replace(/\\/g,'\\\\').replace(/"/g,'\\"')
                      .replace(/\n/g,'\\n').replace(/\r/g,'\\r')
                      .replace(/\t/g,'\\t') + '"';
      }
      if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(JSON.stringify(v[i]));
        return '[' + a.join(',') + ']';
      }
      if (typeof v === 'object') {
        var p = [];
        for (var k in v) {
          if (v.hasOwnProperty(k)) {
            var s = JSON.stringify(v[k]);
            if (s !== undefined) p.push('"' + k + '":' + s);
          }
        }
        return '{' + p.join(',') + '}';
      }
      return undefined;
    };
  }
  if (typeof JSON.parse !== 'function') {
    JSON.parse = function (text) { return eval('(' + text + ')'); };
  }

  // ─── パス正規化 (~ → ホームフォルダ, バックスラッシュ→スラッシュ) ──────
  function normPath(p) {
    if (!p) return '';
    if (p.charAt(0) === '~') {
      var home = Folder.home ? Folder.home.fsName : '';
      p = home + p.substring(1);
    }
    return p.replace(/\\/g, '/');
  }

  // ─── ファイル名のURLデコード ───────────────────────────────────────────────
  // ExtendScript の File.name / File.fsName は日本語等をURLエンコードして返す
  // 例: "名称未設定 1.png" → "%E5%90%8D%E7%A7%B0...%201.png"
  function decodeFileName(s) {
    if (!s) return s;
    // % が含まれていなければそのまま返す
    if (s.indexOf('%') < 0) return s;
    try {
      // decodeURIComponent は ExtendScript でも使える
      // スペースの %20 も含めて全部デコード
      return decodeURIComponent(s);
    } catch(e) {
      // デコード失敗（不正なエンコードなど）はそのまま返す
      return s;
    }
  }

  // fsName もURLエンコードされる場合があるのでデコードして返す
  function decodeFsName(f) {
    try { return decodeURIComponent(f.fsName); } catch(e) { return f.fsName; }
  }

  // ─── ユーティリティ ───────────────────────────────────────────────────────
  function hexToRGB3(hex) {
    hex = (hex || '#ffffff').replace('#','');
    return [parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255, parseInt(hex.slice(4,6),16)/255];
  }
  function rgb3ToHex(c) {
    function h(v){var s=Math.round(v*255).toString(16);return s.length<2?'0'+s:s;}
    return '#'+h(c[0])+h(c[1])+h(c[2]);
  }
  function mapCSSFontToAE(cssFont) {
    cssFont = cssFont || 'sans-serif';
    if (cssFont.indexOf('Hiragino Kaku') >= 0)  return 'HiraKakuProN-W3';
    if (cssFont.indexOf('Meiryo') >= 0)          return 'Meiryo';
    if (cssFont.indexOf('Hiragino Mincho') >= 0) return 'HiraMinProN-W3';
    if (cssFont.indexOf('MS Mincho') >= 0)       return 'MS-Mincho';
    if (cssFont === 'serif')     return 'TimesNewRomanPSMT';
    if (cssFont === 'monospace') return 'CourierNewPSMT';
    return 'ArialMT';
  }
  function mapAEFontToCSS(aeFont) {
    aeFont = aeFont || '';
    if (/HiraKaku|Hiragino.*Kaku/i.test(aeFont))   return "'Hiragino Kaku Gothic ProN','Meiryo',sans-serif";
    if (/Meiryo/i.test(aeFont))                    return "'Hiragino Kaku Gothic ProN','Meiryo',sans-serif";
    if (/HiraMin|Hiragino.*Mincho/i.test(aeFont))  return "'Hiragino Mincho ProN','MS Mincho',serif";
    if (/MSMincho|MS.Mincho/i.test(aeFont))        return "'Hiragino Mincho ProN','MS Mincho',serif";
    if (/Times/i.test(aeFont))   return 'serif';
    if (/Courier/i.test(aeFont)) return 'monospace';
    return 'sans-serif';
  }
  function justToAlign(j) {
    try {
      if (j === ParagraphJustification.LEFT_JUSTIFY)  return 'left';
      if (j === ParagraphJustification.RIGHT_JUSTIFY) return 'right';
    } catch(e) {}
    return 'center';
  }
  function alignToJust(a) {
    try {
      if (a === 'left')  return ParagraphJustification.LEFT_JUSTIFY;
      if (a === 'right') return ParagraphJustification.RIGHT_JUSTIFY;
      return ParagraphJustification.CENTER_JUSTIFY;
    } catch(e) { return undefined; }
  }

  // ─── KFをAEレイヤーに適用 ────────────────────────────────────────────────
  function applyKfToLayer(layer, clip, tStart, cw, ch) {
    if (!clip.kf) return;
    // 位置 KF
    if (clip.kf.pos && clip.kf.pos.length > 0) {
      try {
        var pp = layer.transform.position;
        for (var i=0;i<clip.kf.pos.length;i++) {
          var kp=clip.kf.pos[i];
          pp.setValueAtTime(tStart+kp.t, [cw/2+(kp.x||0), ch/2+(kp.y||0)]);
        }
      } catch(e) {}
    }
    // 回転 KF
    if (clip.kf.rot && clip.kf.rot.length > 0) {
      try {
        var rp = layer.transform.rotation;
        for (var i=0;i<clip.kf.rot.length;i++) {
          var kr=clip.kf.rot[i];
          rp.setValueAtTime(tStart+kr.t, kr.v);
        }
      } catch(e) {}
    } else if (clip.rot && Math.abs(clip.rot) > 0.001) {
      try { layer.transform.rotation.setValue(clip.rot); } catch(e) {}
    }
    // スケール KF
    if (clip.kf.scale && clip.kf.scale.length > 0) {
      try {
        var sp = layer.transform.scale;
        for (var i=0;i<clip.kf.scale.length;i++) {
          var ks=clip.kf.scale[i];
          sp.setValueAtTime(tStart+ks.t, [ks.v*100, ks.v*100]);
        }
      } catch(e) {}
    }
    // 透明度 KF
    if (clip.kf.opacity && clip.kf.opacity.length > 0) {
      try {
        var op = layer.transform.opacity;
        for (var i=0;i<clip.kf.opacity.length;i++) {
          var ko=clip.kf.opacity[i];
          op.setValueAtTime(tStart+ko.t, ko.v*100);
        }
      } catch(e) {}
    } else if (clip.opacity !== undefined && Math.abs(clip.opacity-1) > 0.001) {
      try { layer.transform.opacity.setValue(clip.opacity*100); } catch(e) {}
    }
  }

  // ─── AEレイヤーのトランスフォームをclipに書き出す ────────────────────────
  function exportTransformToClip(lay, clip, tStart, cw, ch) {
    // 位置
    try {
      var pp = lay.transform.position;
      if (pp.numKeys > 0) {
        clip.kf = clip.kf || {};
        clip.kf.pos = [];
        for (var i=1;i<=pp.numKeys;i++) {
          var v=pp.keyValue(i);
          clip.kf.pos.push({t:pp.keyTime(i)-tStart, x:v[0]-cw/2, y:v[1]-ch/2});
        }
        clip.x = clip.kf.pos[0].x; clip.y = clip.kf.pos[0].y;
      } else {
        var pv=pp.value; clip.x=pv[0]-cw/2; clip.y=pv[1]-ch/2;
      }
    } catch(e) {}
    // 回転
    try {
      var rp = lay.transform.rotation;
      if (rp.numKeys > 0) {
        clip.kf = clip.kf || {};
        clip.kf.rot = [];
        for (var i=1;i<=rp.numKeys;i++)
          clip.kf.rot.push({t:rp.keyTime(i)-tStart, v:rp.keyValue(i)});
        clip.rot = clip.kf.rot[0].v;
      } else {
        var rv=rp.value; if (Math.abs(rv)>0.001) clip.rot=rv;
      }
    } catch(e) {}
    // スケール
    try {
      var sp = lay.transform.scale;
      if (sp.numKeys > 0) {
        clip.kf = clip.kf || {};
        clip.kf.scale = [];
        for (var i=1;i<=sp.numKeys;i++) {
          var sv=sp.keyValue(i);
          clip.kf.scale.push({t:sp.keyTime(i)-tStart, v:sv[0]/100});
        }
        clip.scale = clip.kf.scale[0].v;
      } else {
        var sv2=sp.value; clip.scale=sv2[0]/100;
      }
    } catch(e) {}
    // 透明度（単純フェードはfadeIn/fadeOutへ、複雑KFはkf.opacityへ）
    try {
      var op = lay.transform.opacity;
      if (op.numKeys > 0) {
        var nk=op.numKeys, v0=op.keyValue(1), vN=op.keyValue(nk);
        if (nk===2 && v0<5 && vN>95) { clip.fadeIn=op.keyTime(2)-tStart; }
        else if (nk===2 && v0>95 && vN<5) { clip.fadeOut=tStart+(clip.dur||0)-op.keyTime(1); }
        else {
          clip.kf = clip.kf || {};
          clip.kf.opacity = [];
          for (var i=1;i<=nk;i++)
            clip.kf.opacity.push({t:op.keyTime(i)-tStart, v:op.keyValue(i)/100});
          clip.opacity = clip.kf.opacity[0].v;
        }
      } else {
        var ov=op.value; if (Math.abs(ov-100)>0.5) clip.opacity=ov/100;
      }
    } catch(e) {}
  }

  // ─── UI ───────────────────────────────────────────────────────────────────
  function buildUI(thisObj) {
    var win = (thisObj instanceof Panel)
      ? thisObj
      : new Window('dialog', 'Mini2AE  v1.1', undefined, {resizeable: false});

    win.orientation = 'column';
    win.alignChildren = ['fill', 'top'];
    win.spacing = 8;
    win.margins = 14;

    // タイトル
    var titleRow = win.add('group');
    titleRow.orientation = 'column';
    titleRow.alignChildren = ['center', 'top'];
    var titleTxt = titleRow.add('statictext', undefined, 'Mini2AE');
    titleTxt.graphics.font = ScriptUI.newFont('dialog', 'BOLD', 14);
    titleRow.add('statictext', undefined, 'AEmini  ↔  After Effects');

    // ── Import ──
    var impPanel = win.add('panel', undefined, 'インポート  (AEmini JSON → After Effects)');
    impPanel.alignChildren = ['fill', 'top'];
    impPanel.margins = [12, 14, 12, 10];
    impPanel.add('statictext', [0,0,360,28],
      'AEmini JSONを読み込みコンポ・レイヤーを自動生成します。', {multiline:true});
    var folderGrp = impPanel.add('group');
    folderGrp.add('statictext', undefined, '素材フォルダ:');
    var defSozai = '';
    try { defSozai = Folder.desktop.fsName + '/image'; } catch(e) { defSozai = ''; }
    var folderEdit = folderGrp.add('edittext', [0,0,190,20], defSozai);
    var folderPickBtn = folderGrp.add('button', [0,0,28,20], '…');
    var impBtn = impPanel.add('button', undefined, '読み込み (← Import)');

    // ── Export ──
    var expPanel = win.add('panel', undefined, 'エクスポート  (After Effects → AEmini JSON)');
    expPanel.alignChildren = ['fill', 'top'];
    expPanel.margins = [12, 14, 12, 10];
    expPanel.add('statictext', [0,0,360,28],
      'アクティブなコンポをAEmini JSON形式で書き出します。', {multiline:true});
    var expOptGrp = expPanel.add('group');
    expOptGrp.add('statictext', undefined, '対象:');
    var expMode = expOptGrp.add('dropdownlist', undefined,
      ['アクティブなコンポのみ', '全コンポ (ネスト含む)']);
    expMode.selection = 1;
    var expBtn = expPanel.add('button', undefined, '書き出し (Export →)');

    // ── Log ──
    var logPanel = win.add('panel', undefined, 'ログ');
    logPanel.alignChildren = ['fill', 'top'];
    logPanel.margins = [8, 12, 8, 8];
    var logBox = logPanel.add('edittext', [0,0,370,130], '',
      {multiline: true, scrolling: true, readonly: true});
    logBox.preferredSize = [370, 130];

    var btnRow = win.add('group');
    btnRow.orientation = 'row';
    var clearBtn = btnRow.add('button', undefined, 'ログをクリア');
    var spacer = btnRow.add('statictext', undefined, '');
    spacer.preferredSize.width = 170;
    var closeBtn = btnRow.add('button', undefined, '閉じる');

    // ── ヘルパー ──
    function log(msg) {
      var nl = '\r';
      try { if ($.os && $.os.indexOf('Win') < 0) nl = '\n'; } catch(e) {}
      if (typeof logBox.text !== 'string') logBox.text = '';
      logBox.text = logBox.text + String(msg) + nl;
      try {
        var len = logBox.text.length;
        logBox.textselection = {start: len, end: len};
      } catch(e) {}
    }
    function clearLog() { logBox.text = ''; }

    // ── イベント ──
    folderPickBtn.onClick = function () {
      var f = Folder.selectDialog('素材フォルダを選択してください');
      if (f) folderEdit.text = f.fsName;
    };
    clearBtn.onClick = function () { clearLog(); };
    expBtn.onClick = function () {
      clearLog();
      try { doExport(expMode.selection.index === 1, log); }
      catch (e) { log('[エラー] ' + e.message + (e.line ? '  (line ' + e.line + ')' : '')); }
    };
    impBtn.onClick = function () {
      clearLog();
      try { doImport(folderEdit.text, log); }
      catch (e) { log('[エラー] ' + e.message + (e.line ? '  (line ' + e.line + ')' : '')); }
    };
    closeBtn.onClick = function () {
      if (win instanceof Window) win.close();
    };

    if (win instanceof Window) { win.center(); win.show(); }
    else { win.layout.layout(true); }
    return win;
  }

  // ─── アクティブなコンポを確実に取得 ──────────────────────────────────────
  // スクリプトパネルにフォーカスが移ると app.project.activeItem が null になるため
  // 複数の方法でフォールバックして取得する
  function getActiveComp() {
    // 1) 通常の方法
    try {
      var item = app.project.activeItem;
      if (item instanceof CompItem) return item;
    } catch(e) {}

    // 2) プロジェクトパネルで選択中のコンポ
    try {
      for (var i = 1; i <= app.project.numItems; i++) {
        var pi = app.project.items[i];
        if ((pi instanceof CompItem) && pi.selected) return pi;
      }
    } catch(e) {}

    // 3) 開いているビューアのコンポ（AE CS6以降）
    try {
      var viewer = app.activeViewer;
      if (viewer) {
        var comp = viewer.views[0].options.composition;
        if (comp instanceof CompItem) return comp;
      }
    } catch(e) {}

    // 4) タイムラインで最後に開いたコンポを推定
    //    （openedPanels はないため、全コンポ中で最もレイヤー数が多いものを候補に）
    try {
      var best = null, bestLayers = -1;
      for (var i = 1; i <= app.project.numItems; i++) {
        var pi = app.project.items[i];
        if (pi instanceof CompItem && pi.numLayers > bestLayers) {
          bestLayers = pi.numLayers; best = pi;
        }
      }
      if (best) return best;
    } catch(e) {}

    return null;
  }
  function doExport(allComps, log) {
    if (!app.project) { log('プロジェクトが開いていません。'); return; }
    var activeComp = getActiveComp();
    if (!activeComp) {
      log('コンポが見つかりません。\nプロジェクトパネルでコンポを選択してから再度実行してください。');
      return;
    }
    log('── エクスポート開始 ──');
    log('対象コンポ: ' + activeComp.name);

    var proj = buildAEminiProject(activeComp, allComps, log);
    var json = JSON.stringify(proj);
    // 読みやすく整形 (簡易)
    json = json.replace(/,"/g, ',\n  "').replace(/{"/g, '{\n  "').replace(/}/g, '\n}');

    var saveFile = File.saveDialog('AEmini JSON として保存', 'JSON:*.json,*.*');
    if (!saveFile) { log('キャンセルしました。'); return; }
    if (!saveFile.open('w')) {
      log('ファイルを書き込めません: ' + saveFile.fsName); return;
    }
    saveFile.encoding = 'UTF-8';
    saveFile.write(json);
    saveFile.close();
    log('保存先: ' + saveFile.fsName);
    log('コンポ数: ' + proj.comps.length + ' / 素材数: ' + proj.assets.length);
    log('── エクスポート完了 ──');
  }

  // ─── AEレイヤーのトランスフォームをclipに書き出す ────────────────────────
  function exportTransformToClip(lay, clip, tStart, cw, ch) {
    // 位置
    try {
      var pp=lay.transform.position;
      if (pp.numKeys>0) {
        clip.kf=clip.kf||{}; clip.kf.pos=[];
        for(var i=1;i<=pp.numKeys;i++){var v=pp.keyValue(i);clip.kf.pos.push({t:pp.keyTime(i)-tStart,x:v[0]-cw/2,y:v[1]-ch/2});}
        clip.x=clip.kf.pos[0].x; clip.y=clip.kf.pos[0].y;
      } else { var pv=pp.value; clip.x=pv[0]-cw/2; clip.y=pv[1]-ch/2; }
    } catch(e) {}
    // 回転
    try {
      var rp=lay.transform.rotation;
      if (rp.numKeys>0) {
        clip.kf=clip.kf||{}; clip.kf.rot=[];
        for(var i=1;i<=rp.numKeys;i++) clip.kf.rot.push({t:rp.keyTime(i)-tStart,v:rp.keyValue(i)});
        clip.rot=clip.kf.rot[0].v;
      } else { var rv=rp.value; if(Math.abs(rv)>0.001)clip.rot=rv; }
    } catch(e) {}
    // スケール
    try {
      var sp=lay.transform.scale;
      if (sp.numKeys>0) {
        clip.kf=clip.kf||{}; clip.kf.scale=[];
        for(var i=1;i<=sp.numKeys;i++){var sv=sp.keyValue(i);clip.kf.scale.push({t:sp.keyTime(i)-tStart,v:sv[0]/100});}
        clip.scale=clip.kf.scale[0].v;
      } else { var sv2=sp.value; clip.scale=sv2[0]/100; }
    } catch(e) {}
    // 透明度（2点フェードはfadeIn/Out、それ以外はkf.opacity）
    try {
      var op=lay.transform.opacity;
      if (op.numKeys>0) {
        var nk=op.numKeys,v0=op.keyValue(1),vN=op.keyValue(nk);
        if (nk===2&&v0<5&&vN>95) { clip.fadeIn=op.keyTime(2)-tStart; }
        else if (nk===2&&v0>95&&vN<5) { clip.fadeOut=tStart+(clip.dur||0)-op.keyTime(1); }
        else {
          clip.kf=clip.kf||{}; clip.kf.opacity=[];
          for(var i=1;i<=nk;i++) clip.kf.opacity.push({t:op.keyTime(i)-tStart,v:op.keyValue(i)/100});
          clip.opacity=clip.kf.opacity[0].v;
        }
      } else { var ov=op.value; if(Math.abs(ov-100)>0.5)clip.opacity=ov/100; }
    } catch(e) {}
  }

  function buildAEminiProject(mainComp, allComps, log) {
    var uid = 1;
    function nid() { return uid++; }

    var fps = mainComp.frameRate;
    var cw  = mainComp.width;
    var ch  = mainComp.height;

    var proj = {
      version: 5,
      projId: 'ae_' + new Date().getTime(),
      fps: fps, pxPerSec: 120,
      resolution: cw + 'x' + ch,
      timeMode: 'frame',
      comps: [], activeCompId: null,
      folders: [], assets: [], _nid: 0
    };

    // AEのフォルダ構成を収集
    var folderIdMap = {};   // AE item.id → AEmini folder.id
    for (var i = 1; i <= app.project.numItems; i++) {
      var pi = app.project.items[i];
      if (!(pi instanceof FolderItem)) continue;
      // ルートフォルダ(id=1)はスキップ
      if (pi.id === 1) continue;
      var fid = nid();
      folderIdMap[pi.id] = fid;
      // 親フォルダIDを解決（ルートの場合はnull）
      var parentFid = null;
      try {
        var pf = pi.parentFolder;
        if (pf && pf.id !== 1 && folderIdMap[pf.id]) parentFid = folderIdMap[pf.id];
      } catch(e) {}
      proj.folders.push({id: fid, name: pi.name, open: true, parentFolderId: parentFid});
    }
    log('フォルダ: ' + proj.folders.length + ' 件');

    // 素材収集（フォルダIDも付与）
    var assetMap = {};
    for (var i = 1; i <= app.project.numItems; i++) {
      var pi = app.project.items[i];
      if (!(pi instanceof FootageItem)) continue;
      var src = pi.mainSource;

      // 所属フォルダを解決（共通処理）
      var assetFolderId = null;
      try {
        var pf2 = pi.parentFolder;
        if (pf2 && pf2.id !== 1 && folderIdMap[pf2.id]) assetFolderId = folderIdMap[pf2.id];
      } catch(e) {}

      var aid = nid();

      // ── 平面（SolidSource）──────────────────────────────────────────────
      if (src instanceof SolidSource) {
        var solidColor = '#000000';
        try {
          var c = src.color;  // [r,g,b] 各0〜1
          var toHex = function(v) {
            var h = Math.round(v * 255).toString(16);
            return h.length < 2 ? '0' + h : h;
          };
          solidColor = '#' + toHex(c[0]) + toHex(c[1]) + toHex(c[2]);
        } catch(e) {}
        assetMap[pi.id] = aid;
        proj.assets.push({
          id: aid, type: 'solid',
          name: pi.name, originalName: pi.name, displayName: pi.name,
          filePath: null,
          duration: 9999, seqFps: null, frameCount: 1,
          folderId: assetFolderId,
          color: solidColor
        });
        continue;
      }

      // ── ファイル素材 ──────────────────────────────────────────────────
      if (!(src instanceof FileSource)) continue;
      var f = null;
      try { f = src.file; } catch(e) {}
      if (!f) continue;

      var fname = decodeFileName(f.name);
      var ext = '';
      try { ext = fname.split('.').pop().toLowerCase(); } catch(e) {}
      var atype = 'vid';
      if (/^(png|jpg|jpeg|tga|exr|tif|tiff|bmp|gif|dpx|cin)$/.test(ext)) {
        atype = (pi.duration > 0 && !src.isStill) ? 'seq' : 'img';
      } else if (/^(mp3|wav|aif|aiff|aac|m4a|ogg|flac)$/.test(ext)) {
        atype = 'aud';
      }

      assetMap[pi.id] = aid;
      var fpath = '';
      try { fpath = decodeFsName(f); } catch(e) {}
      proj.assets.push({
        id: aid, type: atype,
        name: fname, originalName: fname, displayName: fname,
        filePath: fpath,
        duration: pi.duration,
        seqFps: (atype === 'seq') ? fps : null,
        frameCount: (atype === 'seq') ? Math.round(pi.duration * fps) : 0,
        folderId: assetFolderId
      });
    }
    log('素材: ' + proj.assets.length + ' 件 (うち平面: ' + (function(){var cnt=0;for(var _i=0;_i<proj.assets.length;_i++){if(proj.assets[_i].type==='solid')cnt++;}return cnt;})() + ' 件)');

    // 対象コンポを決定
    var compsToExport = [mainComp];
    if (allComps) {
      for (var i = 1; i <= app.project.numItems; i++) {
        var pi = app.project.items[i];
        if ((pi instanceof CompItem) && pi.id !== mainComp.id) compsToExport.push(pi);
      }
    } else {
      var visited = {};
      visited[mainComp.id] = true;
      var queue = [mainComp];
      while (queue.length) {
        var cur = queue.shift();
        for (var li = 1; li <= cur.numLayers; li++) {
          var lay = cur.layers[li];
          if ((lay instanceof AVLayer) && (lay.source instanceof CompItem)) {
            var nc = lay.source;
            if (!visited[nc.id]) { visited[nc.id] = true; compsToExport.push(nc); queue.push(nc); }
          }
        }
      }
    }

    var compIdMap = {};
    for (var ci = 0; ci < compsToExport.length; ci++) {
      compIdMap[compsToExport[ci].id] = nid();
    }
    proj.activeCompId = compIdMap[mainComp.id];

    for (var ci = 0; ci < compsToExport.length; ci++) {
      var aeComp = compsToExport[ci];
      var cid = compIdMap[aeComp.id];
      var tlvComp = {
        id: cid, name: aeComp.name, dur: aeComp.duration,
        vLayers: [], aTracks: [], clips: [], aClips: []
      };

      for (var li = 1; li <= aeComp.numLayers; li++) {
        var lay = aeComp.layers[li];
        if (!lay.enabled) continue;
        if (lay instanceof CameraLayer || lay instanceof LightLayer) continue;

        var tStart = 0, durL = 0, trimIn = 0, speed = 1;
        try {
          tStart = lay.inPoint;
          durL   = lay.outPoint - lay.inPoint;
          trimIn = lay.inPoint - lay.startTime;
          if (trimIn < 0) trimIn = 0;
          speed  = (lay.stretch !== 0) ? (100 / lay.stretch) : 1;
        } catch(e) {}
        if (durL <= 0) continue;

        // ── テキストレイヤー ────────────────────────────────────────────
        var isTextLay = false;
        try { isTextLay = (lay instanceof TextLayer); } catch(e) {}
        if (isTextLay) {
          var textAid = nid();
          var textAsset = {
            id: textAid, type: 'text',
            name: lay.name, originalName: lay.name, displayName: lay.name,
            filePath: null, duration: 9999, seqFps: null, frameCount: 1, folderId: null,
            text: lay.name, fontSize: 80, fontFamily: 'sans-serif',
            align: 'center', bold: false, italic: false, stroke: 0, strokeColor: '#000000', color: '#ffffff'
          };
          try {
            var td = lay.sourceText.value;
            textAsset.text      = td.text || lay.name;
            textAsset.fontSize  = td.fontSize || 80;
            textAsset.color     = rgb3ToHex(td.fillColor || [1,1,1]);
            textAsset.fontFamily= mapAEFontToCSS(td.font || '');
            textAsset.align     = justToAlign(td.justification);
            try { textAsset.bold=!!td.bold; } catch(e2) {}
            try { textAsset.italic=!!td.italic; } catch(e2) {}
            if (td.strokeWidth>0) { textAsset.stroke=Math.round(td.strokeWidth/2); textAsset.strokeColor=rgb3ToHex(td.strokeColor||[0,0,0]); }
          } catch(e) {}
          proj.assets.push(textAsset);

          var tvid = nid();
          tlvComp.vLayers.push({id:tvid, name:lay.name});
          var tclip = {id:nid(),layerId:tvid,assetId:textAid,tStart:tStart,dur:durL,trimIn:0,speed:speed,fadeIn:0,fadeOut:0,x:0,y:0,scale:1,natW:aeComp.width,natH:aeComp.height};
          exportTransformToClip(lay, tclip, tStart, aeComp.width, aeComp.height);
          tlvComp.clips.push(tclip);
          log('  TEXT: ' + lay.name);
          continue;
        }

        if (!(lay instanceof AVLayer)) continue;

        var srcItem = null;
        try { srcItem = lay.source; } catch(e) {}

        var isAudioOnly = false;
        try { if (srcItem instanceof FootageItem) isAudioOnly = srcItem.hasAudio && !srcItem.hasVideo; } catch(e) {}

        if (isAudioOnly) {
          var tid = nid();
          tlvComp.aTracks.push({id:tid, name:lay.name});
          tlvComp.aClips.push({id:nid(), assetId:(srcItem&&assetMap[srcItem.id])?assetMap[srcItem.id]:null, trackId:tid, tStart:tStart, dur:durL, trimIn:trimIn, speed:speed, vol:1});
        } else {
          var vid = nid();
          tlvComp.vLayers.push({id:vid, name:lay.name});
          var clip = {id:nid(),layerId:vid, tStart:tStart,dur:durL,trimIn:trimIn,speed:speed, fadeIn:0,fadeOut:0, x:0,y:0,scale:1, natW:aeComp.width,natH:aeComp.height};
          if ((srcItem instanceof CompItem) && compIdMap[srcItem.id]) clip.compId = compIdMap[srcItem.id];
          else if (srcItem && assetMap[srcItem.id]) clip.assetId = assetMap[srcItem.id];
          exportTransformToClip(lay, clip, tStart, aeComp.width, aeComp.height);
          tlvComp.clips.push(clip);
        }
      }

      proj.comps.push(tlvComp);
      log('  ' + aeComp.name + ': V=' + tlvComp.clips.length + ' / A=' + tlvComp.aClips.length);
    }

    proj._nid = uid;
    return proj;
  }

  // ─── IMPORT ───────────────────────────────────────────────────────────────
  function doImport(sozaiRootPath, log) {
    var jsonFile = File.openDialog('AEmini JSON ファイルを選択', 'JSON:*.json,*.*');
    if (!jsonFile) { log('キャンセルしました。'); return; }

    if (!jsonFile.open('r')) {
      log('ファイルを開けません: ' + jsonFile.fsName); return;
    }
    jsonFile.encoding = 'UTF-8';
    var text = '';
    try { text = jsonFile.read(); } catch(e) { log('読み込みエラー: ' + e.message); return; }
    jsonFile.close();

    var proj = null;
    try { proj = JSON.parse(text); }
    catch(e) { log('JSON 解析エラー: ' + e.message); return; }
    if (!proj || typeof proj !== 'object') { log('JSONの形式が不正です。'); return; }

    if ((proj.version || 0) < 5) {
      log('非対応バージョンです (version=' + proj.version + ', 5以上が必要)'); return;
    }

    log('── インポート開始 ──');
    log('ファイル: ' + jsonFile.name);

    var fps = proj.fps || 24;
    var res = [];
    try { res = (proj.resolution || '1920x1080').split('x'); } catch(e) {}
    var cw = parseInt(res[0]) || 1920;
    var ch = parseInt(res[1]) || 1080;
    log('解像度: ' + cw + 'x' + ch + '  FPS: ' + fps);

    // ── 素材フォルダの解決 ────────────────────────────────────────────────
    var sozaiRoot = null;
    try {
      if (sozaiRootPath && sozaiRootPath !== '') {
        var rpath = normPath(sozaiRootPath);
        var rf = new Folder(rpath);
        if (rf.exists) {
          sozaiRoot = rf;
          log('素材フォルダ: ' + rf.fsName);
        } else {
          log('警告: 素材フォルダが見つかりません → ' + rpath);
        }
      }
    } catch(e) {
      log('警告: 素材フォルダの解決に失敗しました: ' + e.message);
    }

    // ── ファイルキャッシュ構築 ────────────────────────────────────────────
    var fileCache = {};
    if (sozaiRoot) {
      try {
        buildFileCache(sozaiRoot, fileCache);
        var fc = 0; for (var k in fileCache) { if (fileCache.hasOwnProperty(k)) fc++; }
        log(fc + ' ファイルをキャッシュしました。');
      } catch(e) {
        log('警告: ファイルキャッシュ構築に失敗しました: ' + e.message);
      }
    }

    // ── 素材インポート ────────────────────────────────────────────────────
    var assetMap = {};
    var solidColorMap = {};
    var textAssetMap  = {};
    var assets = proj.assets || [];
    var okCnt = 0, ngCnt = 0;
    for (var ai = 0; ai < assets.length; ai++) {
      var asset = assets[ai];
      if (!asset || asset.type === 'comp') continue;

      // テキスト素材: ファイル不要→textAssetMapに格納してpopulateCompでレイヤー生成
      if (asset.type === 'text') {
        textAssetMap[asset.id] = asset;
        okCnt++;
        log('  OK (テキスト): ' + (asset.name||'text'));
        continue;
      }

      // 平面: footage item は作らず色情報だけ保持 → populateComp で layers.addSolid()
      if (asset.type === 'solid' && asset.color) {
        try {
          var hexColor = asset.color;
          var rv = parseInt(hexColor.slice(1,3),16) / 255;
          var gv = parseInt(hexColor.slice(3,5),16) / 255;
          var bv = parseInt(hexColor.slice(5,7),16) / 255;
          solidColorMap[asset.id] = {
            r: rv, g: gv, b: bv,
            name: asset.name || 'Solid',
            hex: hexColor,
            folderId: asset.folderId || null
          };
          okCnt++;
          log('  OK (平面): ' + (asset.name||'Solid') + '  ' + hexColor);
        } catch(e) {
          log('  [エラー] 平面情報の取得失敗 (' + (asset.name||'?') + '): ' + e.message);
          ngCnt++;
        }
        continue;
      }

      try {
        var footage = importAssetItem(asset, fileCache, sozaiRoot, log);
        if (footage) { assetMap[asset.id] = footage; okCnt++; }
        else ngCnt++;
      } catch(e) {
        log('  [エラー] 素材インポート失敗 (' + (asset.name||'?') + '): ' + e.message);
        ngCnt++;
      }
    }
    log('素材: ' + okCnt + ' 件 OK / ' + ngCnt + ' 件 見つからず');

    // ── AEフォルダ構成を再現 ──────────────────────────────────────────────
    // parentFolderId を持つ入れ子も考慮し、ルートから順に作成する
    var aeFolderMap = {};  // TLV folder.id → AE FolderItem
    var folders = proj.folders || [];
    if (folders.length > 0) {
      // ルートフォルダ（parentFolderIdなし）を先に作成
      function createFolderRecursive(folderList, parentAeFolder) {
        for (var fi = 0; fi < folderList.length; fi++) {
          var tf = folderList[fi];
          try {
            var aeFolder = app.project.items.addFolder(tf.name || 'フォルダ');
            // 親フォルダがあれば移動
            if (parentAeFolder) {
              try { aeFolder.parentFolder = parentAeFolder; } catch(e) {}
            }
            aeFolderMap[tf.id] = aeFolder;
            // 子フォルダを再帰作成
            var children = [];
            for (var ci2 = 0; ci2 < folders.length; ci2++) {
              if (folders[ci2].parentFolderId === tf.id) children.push(folders[ci2]);
            }
            if (children.length > 0) createFolderRecursive(children, aeFolder);
          } catch(e) {
            log('  [警告] フォルダ作成失敗 (' + (tf.name||'?') + '): ' + e.message);
          }
        }
      }
      var rootFolders = [];
      for (var fi = 0; fi < folders.length; fi++) {
        if (!folders[fi].parentFolderId) rootFolders.push(folders[fi]);
      }
      createFolderRecursive(rootFolders, null);
      log('フォルダ再現: ' + folders.length + ' 件');
    }

    // ── コンポ作成 ────────────────────────────────────────────────────────
    var compMap = {};
    var comps = proj.comps || [];
    for (var ci = 0; ci < comps.length; ci++) {
      var tc = comps[ci];
      var tcW = tc.width || cw;
      var tcH = tc.height || ch;
      try {
        var aeComp = app.project.items.addComp(
          tc.name || ('Comp' + (ci + 1)), tcW, tcH, 1.0, tc.dur || 10, fps);
        compMap[tc.id] = aeComp;
        log('コンポ作成: ' + tc.name + '  (' + (tc.dur || 10) + '秒)  ' + tcW + 'x' + tcH);
      } catch(e) {
        log('[エラー] コンポ作成失敗 (' + (tc.name||'?') + '): ' + e.message);
      }
    }

    // ── コンポをフォルダに移動 ────────────────────────────────────────────
    for (var ci2 = 0; ci2 < comps.length; ci2++) {
      var tc2 = comps[ci2];
      if (!tc2.folderId) continue;
      var compFolderTarget = aeFolderMap[tc2.folderId];
      if (!compFolderTarget) continue;
      try {
        if (compMap[tc2.id]) compMap[tc2.id].parentFolder = compFolderTarget;
      } catch(e) {}
    }

    // ── タイムライン未配置の平面をAEプロジェクトに生成 ──────────────────
    // solidColorMapに登録されているが、どのコンポのレイヤーにも使われていない平面
    // → AEプロジェクトパネルに単体FootageItemとして生成する
    var usedSolidIds = {};
    for (var ci3 = 0; ci3 < comps.length; ci3++) {
      var tc3 = comps[ci3];
      var clips3 = tc3.clips || [];
      for (var cj = 0; cj < clips3.length; cj++) {
        if (clips3[cj].assetId) usedSolidIds[clips3[cj].assetId] = true;
      }
    }
    for (var sid in solidColorMap) {
      if (!solidColorMap.hasOwnProperty(sid)) continue;
      if (usedSolidIds[sid]) continue; // 配置済みはスキップ
      var si = solidColorMap[sid];
      try {
        var unplacedSolid = app.project.items.addSolid(
          [si.r, si.g, si.b], si.name, cw, ch, 1.0);
        // フォルダ移動
        try {
          if (si.folderId && aeFolderMap[si.folderId]) {
            unplacedSolid.parentFolder = aeFolderMap[si.folderId];
          } else {
            unplacedSolid.parentFolder = app.project.rootFolder;
          }
        } catch(e) {}
        log('  未配置平面を追加: ' + si.name);
      } catch(e) {
        log('  [エラー] 未配置平面の追加失敗 (' + si.name + '): ' + e.message);
      }
    }

    // ── 素材をフォルダに移動 ──────────────────────────────────────────────
    for (var ai2 = 0; ai2 < assets.length; ai2++) {
      var ast = assets[ai2];
      if (!ast || !ast.folderId) continue;
      var targetFolder = aeFolderMap[ast.folderId];
      if (!targetFolder) continue;
      if (assetMap[ast.id]) {
        try { assetMap[ast.id].parentFolder = targetFolder; } catch(e) {}
      }
    }

    // ── レイヤー配置 ─────────────────────────────────────────────────────
    // assetId → 素材表示名 のマップを作成（不明素材の名前に使う）
    var assetNameMap = {};
    for (var ani = 0; ani < assets.length; ani++) {
      var an = assets[ani];
      if (an && an.id) assetNameMap[an.id] = an.displayName || an.name || ('id:' + an.id);
    }

    for (var ci = 0; ci < comps.length; ci++) {
      var tc   = comps[ci];
      var aeC  = compMap[tc.id];
      if (!aeC) continue;
      log('レイヤー配置: ' + tc.name + ' ...');
      try {
        populateComp(aeC, tc, assetMap, assetNameMap, solidColorMap, textAssetMap, compMap, aeFolderMap, cw, ch, log);
      } catch(e) {
        log('[エラー] レイヤー配置中に予期せぬエラー: ' + e.message + (e.line ? ' (line ' + e.line + ')' : ''));
      }
    }

    // ── AEが自動生成した空の「ソリッド」フォルダを削除 ───────────────────
    // addSolid() で必ず作られるが、source.parentFolder で移動済みなので空になっている
    try {
      for (var ii = app.project.numItems; ii >= 1; ii--) {
        var pItem = app.project.items[ii];
        if (!(pItem instanceof FolderItem)) continue;
        if (pItem.numItems > 0) continue;  // 中身があれば残す
        // AEが自動生成するソリッドフォルダ名（日本語版: "ソリッド", 英語版: "Solids"）
        var fn = pItem.name;
        if (fn === 'ソリッド' || fn === 'Solids' || fn === '平面') {
          // ユーザーが意図的に作ったフォルダかチェック: aeFolderMapに含まれていなければAE自動生成
          var isUserFolder = false;
          for (var fk in aeFolderMap) {
            if (aeFolderMap.hasOwnProperty(fk) && aeFolderMap[fk] === pItem) {
              isUserFolder = true; break;
            }
          }
          if (!isUserFolder) {
            try { pItem.remove(); log('空フォルダを削除: ' + fn); } catch(e) {}
          }
        }
      }
    } catch(e) {}

    // アクティブなコンポを開く
    try {
      if (proj.activeCompId && compMap[proj.activeCompId]) {
        compMap[proj.activeCompId].openInViewer();
      }
    } catch(e) {}

    log('── インポート完了 ──');
  }

  function populateComp(aeComp, tlvComp, assetMap, assetNameMap, solidColorMap, textAssetMap, compMap, aeFolderMap, cw, ch, log) {
    var vLayers = tlvComp.vLayers || [];
    var clips   = tlvComp.clips   || [];
    var aTracks = tlvComp.aTracks || [];
    var aClips  = tlvComp.aClips  || [];

    var layerOrder = {};
    for (var li = 0; li < vLayers.length; li++) layerOrder[vLayers[li].id] = li;

    var sortedClips = clips.slice().sort(function (a, b) {
      var ia = (layerOrder[a.layerId] !== undefined) ? layerOrder[a.layerId] : 9999;
      var ib = (layerOrder[b.layerId] !== undefined) ? layerOrder[b.layerId] : 9999;
      return ib - ia;
    });

    for (var ci = 0; ci < sortedClips.length; ci++) {
      var clip = sortedClips[ci];
      var layName = '';
      for (var li2 = 0; li2 < vLayers.length; li2++) {
        if (vLayers[li2].id === clip.layerId) { layName = vLayers[li2].name; break; }
      }
      var tStart = Number(clip.tStart) || 0;
      var dur    = Number(clip.dur)    || 1;
      var trimIn = Number(clip.trimIn) || 0;
      var speed  = Number(clip.speed)  || 1;

      // ── 平面クリップ ──────────────────────────────────────────────────
      var solidInfo = solidColorMap[clip.assetId];
      if (solidInfo) {
        try {
          var sl = aeComp.layers.addSolid([solidInfo.r,solidInfo.g,solidInfo.b], solidInfo.name, cw, ch, 1.0, dur);
          try { if (solidInfo.folderId&&aeFolderMap[solidInfo.folderId]) sl.source.parentFolder=aeFolderMap[solidInfo.folderId]; else sl.source.parentFolder=app.project.rootFolder; } catch(e) {}
          try { if (layName) sl.name=layName; } catch(e) {}
          try { sl.startTime=tStart; sl.inPoint=tStart; sl.outPoint=tStart+dur; } catch(e) {}
          if (!clip.kf||!clip.kf.pos) { try { if ((clip.x||0)!==0||(clip.y||0)!==0) sl.transform.position.setValue([cw/2+(clip.x||0),ch/2+(clip.y||0)]); } catch(e) {} }
          if (!clip.kf||!clip.kf.scale) { try { var ss=Number(clip.scale)||1; if (Math.abs(ss-1)>0.001) sl.transform.scale.setValue([ss*100,ss*100]); } catch(e) {} }
          applyKfToLayer(sl, clip, tStart, cw, ch);
          if (!clip.kf||!clip.kf.opacity) { try { var fi=Number(clip.fadeIn)||0,fo=Number(clip.fadeOut)||0; if(fi>0||fo>0){var op=sl.transform.opacity;if(fi>0){op.setValueAtTime(tStart,0);op.setValueAtTime(tStart+fi,100);}if(fo>0){op.setValueAtTime(tStart+dur-fo,100);op.setValueAtTime(tStart+dur,0);}} } catch(e) {} }
          log('  SOLID: ' + sl.name + '  ' + solidInfo.hex);
        } catch(e) { log('  [エラー] 平面追加失敗 (' + layName + '): ' + e.message); }
        continue;
      }

      // ── テキストクリップ ─────────────────────────────────────────────
      var textInfo = textAssetMap && textAssetMap[clip.assetId];
      if (textInfo) {
        try {
          var tl = aeComp.layers.addText(textInfo.text || '');
          try { if (layName) tl.name=layName; } catch(e) {}
          try {
            var srcP=tl.sourceText, doc=srcP.value;
            doc.fontSize = Number(textInfo.fontSize)||80;
            doc.fillColor = hexToRGB3(textInfo.color||'#ffffff');
            try { doc.font = mapCSSFontToAE(textInfo.fontFamily||'sans-serif'); } catch(e2) {}
            try { var j=alignToJust(textInfo.align||'center'); if(j!==undefined)doc.justification=j; } catch(e2) {}
            if (Number(textInfo.stroke)>0) { try { doc.strokeColor=hexToRGB3(textInfo.strokeColor||'#000000'); doc.strokeWidth=Number(textInfo.stroke)*2; doc.strokeOverFill=true; } catch(e2) {} }
            srcP.setValue(doc);
          } catch(e) { log('  [警告] テキスト属性失敗: '+e.message); }
          try { tl.startTime=tStart; tl.inPoint=tStart; tl.outPoint=tStart+dur; } catch(e) {}
          if (!clip.kf||!clip.kf.pos) { try { if((clip.x||0)!==0||(clip.y||0)!==0) tl.transform.position.setValue([cw/2+(clip.x||0),ch/2+(clip.y||0)]); } catch(e) {} }
          if (!clip.kf||!clip.kf.scale) { try { var ts=Number(clip.scale)||1; if(Math.abs(ts-1)>0.001) tl.transform.scale.setValue([ts*100,ts*100]); } catch(e) {} }
          applyKfToLayer(tl, clip, tStart, cw, ch);
          log('  TEXT: ' + tl.name);
        } catch(e) { log('  [エラー] テキスト追加失敗 (' + layName + '): ' + e.message); }
        continue;
      }

      // ── 通常クリップ ─────────────────────────────────────────────────
      var src = null;
      try {
        if (clip.compId !== undefined) src = compMap[clip.compId] || null;
        else if (clip.assetId !== undefined) src = assetMap[clip.assetId] || null;
      } catch(e) {}

      if (!src) {
        var dispName = (clip.assetId&&assetNameMap&&assetNameMap[clip.assetId]) ? assetNameMap[clip.assetId] : '';
        var phName = dispName ? (dispName+' [不明]') : (layName ? layName+' [不明]' : '不明_'+(clip.assetId||'?'));
        log('  [不明] 素材なし → グレー平面: ' + phName);
        try {
          var pl = aeComp.layers.addSolid([0.45,0.45,0.45], phName, cw, ch, 1.0, dur);
          try { pl.source.parentFolder=app.project.rootFolder; } catch(e2) {}
          try { pl.startTime=tStart-trimIn; pl.inPoint=tStart; pl.outPoint=tStart+dur; } catch(e2) {}
          try { if((clip.x||0)!==0||(clip.y||0)!==0) pl.transform.position.setValue([cw/2+(clip.x||0),ch/2+(clip.y||0)]); } catch(e2) {}
          try { var ps=Number(clip.scale)||1; if(Math.abs(ps-1)>0.001) pl.transform.scale.setValue([ps*100,ps*100]); } catch(e2) {}
          applyKfToLayer(pl, clip, tStart, cw, ch);
          log('  V (不明): ' + pl.name);
        } catch(e) { log('  [エラー] 代用平面失敗: ' + e.message); }
        continue;
      }

      try {
        var layer = aeComp.layers.add(src);
        try { if (layName) layer.name=layName; } catch(e) {}
        try { if (Math.abs(speed-1)>0.001) layer.stretch=100/speed; } catch(e) {}
        try { layer.startTime=tStart-trimIn; layer.inPoint=tStart; layer.outPoint=tStart+dur; } catch(e) {}
        // 静的トランスフォーム（KFなし時のみ）
        if (!clip.kf||!clip.kf.pos) { try { if((clip.x||0)!==0||(clip.y||0)!==0) layer.transform.position.setValue([cw/2+(clip.x||0),ch/2+(clip.y||0)]); } catch(e) {} }
        if (!clip.kf||!clip.kf.scale) { try { var sc=Number(clip.scale)||1; if(Math.abs(sc-1)>0.001) layer.transform.scale.setValue([sc*100,sc*100]); } catch(e) {} }
        // KFを適用
        applyKfToLayer(layer, clip, tStart, cw, ch);
        // フェードイン/アウト（KF透明度がない場合のみ）
        if (!clip.kf||!clip.kf.opacity) {
          try { var fi2=Number(clip.fadeIn)||0,fo2=Number(clip.fadeOut)||0; if(fi2>0||fo2>0){var op2=layer.transform.opacity;if(fi2>0){op2.setValueAtTime(tStart,0);op2.setValueAtTime(tStart+fi2,100);}if(fo2>0){op2.setValueAtTime(tStart+dur-fo2,100);op2.setValueAtTime(tStart+dur,0);}}} catch(e) {}
        }
        // ガウスぼかし
        try {
          var blurVal=Number(clip.blur)||0;
          if (blurVal>0) {
            var blurEff=null;
            try { blurEff=layer.Effects.addProperty('ADBE Gaussian Blur 2'); } catch(e) {}
            if (!blurEff) { try { blurEff=layer.Effects.addProperty('Gaussian Blur'); } catch(e) {} }
            if (blurEff) { try{blurEff.property(1).setValue(blurVal);}catch(e){} try{blurEff.property(3).setValue(true);}catch(e){} log('  ブラー: '+blurVal+'px → '+layer.name); }
          }
        } catch(e) {}
        log('  V: ' + layer.name);
      } catch(e) { log('  [エラー] Vレイヤー追加失敗 (' + layName + '): ' + e.message); }
    }

    // ── 音声クリップ ─────────────────────────────────────────────────────
    var trackOrder = {};
    for (var ti = 0; ti < aTracks.length; ti++) trackOrder[aTracks[ti].id] = ti;
    var sortedAClips = aClips.slice().sort(function (a, b) {
      var ia = (trackOrder[a.trackId] !== undefined) ? trackOrder[a.trackId] : 9999;
      var ib = (trackOrder[b.trackId] !== undefined) ? trackOrder[b.trackId] : 9999;
      return ib - ia;
    });

    for (var ai = 0; ai < sortedAClips.length; ai++) {
      var aclip = sortedAClips[ai];
      var asrc  = assetMap[aclip.assetId] || null;
      if (!asrc) { log('  [スキップ] 音声素材なし (assetId=' + aclip.assetId + ')'); continue; }

      var atName = '';
      for (var ti2 = 0; ti2 < aTracks.length; ti2++) {
        if (aTracks[ti2].id === aclip.trackId) { atName = aTracks[ti2].name; break; }
      }

      try {
        var alayer = aeComp.layers.add(asrc);
        try { if (atName) alayer.name = atName; } catch(e) {}

        var atStart = Number(aclip.tStart) || 0;
        var adur    = Number(aclip.dur)    || 1;
        var atrimIn = Number(aclip.trimIn) || 0;

        try { alayer.startTime = atStart - atrimIn; } catch(e) { try { alayer.startTime = 0; } catch(e2) {} }
        try { alayer.inPoint   = atStart;            } catch(e) {}
        try { alayer.outPoint  = atStart + adur;     } catch(e) {}

        // 音量
        try {
          var vol = Number(aclip.vol);
          if (!isNaN(vol) && Math.abs(vol - 1) > 0.01 && vol > 0) {
            var db = 20 * (Math.log(vol) / Math.LN10);
            alayer.audio.audioLevels.setValue([db, db]);
          }
        } catch(e) {}

        log('  A: ' + alayer.name);
      } catch(e) {
        log('  [エラー] A レイヤー追加失敗 (' + atName + '): ' + e.message);
      }
    }
  }

  // ─── 素材インポート ───────────────────────────────────────────────────────
  function importAssetItem(asset, fileCache, sozaiRoot, log) {
    var isSeq = (asset.type === 'seq');

    function tryImport(fileObj) {
      var io = new ImportOptions(fileObj);
      io.sequence = isSeq;
      try {
        return app.project.importFile(io);
      } catch(e) {
        if (isSeq) {
          var io2 = new ImportOptions(fileObj);
          io2.sequence = false;
          return app.project.importFile(io2);
        }
        throw e;
      }
    }

    // 1) 保存済みフルパス（元パス・正規化パス両方試す）
    if (asset.filePath) {
      var pathCandidates = [asset.filePath, normPath(asset.filePath)];
      for (var pi = 0; pi < pathCandidates.length; pi++) {
        try {
          var f = new File(pathCandidates[pi]);
          if (f.exists) {
            var item = tryImport(f);
            log('  OK (パス): ' + asset.name);
            return item;
          }
        } catch(e) {}
      }
    }

    // 2) キャッシュ検索（lowercase比較）
    var fname = String(asset.name || asset.originalName || '');
    if (fname && fileCache[fname.toLowerCase()]) {
      try {
        var item2 = tryImport(fileCache[fname.toLowerCase()]);
        log('  OK (キャッシュ): ' + asset.name);
        return item2;
      } catch(e) {}
    }

    // 3) OSレベル直接検索: folder.getFiles(filename) でOSにマッチングさせる
    //    → 日本語ファイル名のエンコーディング差異を回避できる
    if (fname && sozaiRoot) {
      try {
        var found = searchInFolder(sozaiRoot, fname);
        if (found) {
          var item3 = tryImport(found);
          log('  OK (OS検索): ' + asset.name);
          return item3;
        }
      } catch(e) {}
    }

    log('  × 見つかりません: ' + fname);
    return null;
  }

  // OSに任せてファイルを再帰検索 (日本語ファイル名エンコーディング問題を回避)
  function searchInFolder(folder, filename) {
    // getFiles(mask) はOSがファイル名マッチングをするので文字コード依存しない
    try {
      var files = folder.getFiles(filename);
      if (files && files.length > 0) {
        for (var i = 0; i < files.length; i++) {
          if (files[i] instanceof File) return files[i];
        }
      }
    } catch(e) {}
    // サブフォルダを再帰検索
    try {
      var all = folder.getFiles();
      if (all) {
        for (var i = 0; i < all.length; i++) {
          if (all[i] instanceof Folder) {
            var result = searchInFolder(all[i], filename);
            if (result) return result;
          }
        }
      }
    } catch(e) {}
    return null;
  }

  // ─── ファイルキャッシュ構築 (再帰, ASCII系ファイル用) ──────────────────────
  function buildFileCache(folder, cache) {
    var items = null;
    try { items = folder.getFiles(); } catch(e) { return; }
    if (!items || !items.length) return;
    for (var i = 0; i < items.length; i++) {
      try {
        var f = items[i];
        if (f instanceof File) {
          var decoded = decodeFileName(f.name);
          // デコード済み・lowercase・元のままの3パターンでキャッシュ
          if (!cache[decoded])              cache[decoded]              = f;
          if (!cache[decoded.toLowerCase()]) cache[decoded.toLowerCase()] = f;
          if (!cache[f.name])               cache[f.name]               = f;
        } else if (f instanceof Folder) {
          buildFileCache(f, cache);
        }
      } catch(e) {}
    }
  }

  // ─── 起動 ─────────────────────────────────────────────────────────────────
  buildUI(thisObj);

}(this));
