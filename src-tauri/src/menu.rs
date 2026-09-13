//! 家族标准应用菜单（见《Rocktier家族软件通用准则》菜单一章）。
//! 自定义项点击经 `on_menu_event` 转成 `menu-action` 事件发给前端。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

pub const WEBSITE: &str = "https://rocktier.com/pic2webp.html";


macro_rules! tr8 {
    ($en:expr, $zh:expr, $ja:expr, $ko:expr, $de:expr, $es:expr, $pt:expr, $ar:expr) => {
        &[
            ("en", $en), ("zh", $zh), ("ja", $ja), ("ko", $ko),
            ("de", $de), ("es", $es), ("pt", $pt), ("ar", $ar),
        ]
    };
}

fn pick(lang: &str, items: &[(&'static str, &'static str)]) -> &'static str {
    let base = lang.split('-').next().unwrap_or(lang).split('_').next().unwrap_or(lang);
    items
        .iter()
        .find(|(c, _)| *c == base)
        .map(|(_, v)| *v)
        .unwrap_or(items[0].1)
}

pub fn build(app: &tauri::AppHandle, lang: &str) -> tauri::Result<()> {
    let l = |items: &[(&'static str, &'static str)]| pick(lang, items);

    let open_i = MenuItem::with_id(
        app,
        "open",
        l(tr8!("Open Images…", "打开图片…", "画像を開く…", "이미지 열기…", "Bilder öffnen…", "Abrir imágenes…", "Abrir imagens…", "فتح الصور…")),
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let clear_i = MenuItem::with_id(app, "clear", l(tr8!("Clear List", "清空列表", "リストをクリア", "목록 지우기", "Liste leeren", "Vaciar lista", "Limpar lista", "مسح القائمة")), true, None::<&str>)?;
    let theme_i = MenuItem::with_id(
        app,
        "theme",
        l(tr8!("Toggle Theme", "切换深浅主题", "テーマ切替", "테마 전환", "Design wechseln", "Cambiar tema", "Alternar tema", "تبديل السمة")),
        true,
        None::<&str>,
    )?;
    let site_i = MenuItem::with_id(app, "website", l(tr8!("Website", "官方网站", "公式サイト", "공식 사이트", "Webseite", "Sitio web", "Site oficial", "الموقع الرسمي")), true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        "Pic2WebP",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(l(tr8!("About Pic2WebP", "关于 Pic2WebP", "Pic2WebP について", "Pic2WebP 정보", "Über Pic2WebP", "Acerca de Pic2WebP", "Sobre o Pic2WebP", "حول Pic2WebP"))), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        l(tr8!("File", "文件", "ファイル", "파일", "Datei", "Archivo", "Arquivo", "ملف")),
        true,
        &[
            &open_i,
            &clear_i,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        l(tr8!("Edit", "编辑", "編集", "편집", "Bearbeiten", "Editar", "Editar", "تحرير")),
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(app, l(tr8!("View", "显示", "表示", "보기", "Ansicht", "Ver", "Ver", "عرض")), true, &[&theme_i])?;

    let window_menu = Submenu::with_items(
        app,
        l(tr8!("Window", "窗口", "ウィンドウ", "창", "Fenster", "Ventana", "Janela", "نافذة")),
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        l(tr8!("Help", "帮助", "ヘルプ", "도움말", "Hilfe", "Ayuda", "Ajuda", "مساعدة")),
        true,
        &[&site_i],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    app.set_menu(menu)?;
    Ok(())
}
