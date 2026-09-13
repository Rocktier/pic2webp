//! 家族标准应用菜单（见《Rocktier家族软件通用准则》菜单一章）。
//! 自定义项点击经 `on_menu_event` 转成 `menu-action` 事件发给前端。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

pub const WEBSITE: &str = "https://rocktier.com/pic2webp.html";

pub fn build(app: &tauri::AppHandle, lang: &str) -> tauri::Result<()> {
    let zh = lang.starts_with("zh");
    let l = |zhv: &'static str, en: &'static str| if zh { zhv } else { en };

    let open_i = MenuItem::with_id(
        app,
        "open",
        l("打开图片…", "Open Images…"),
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let clear_i = MenuItem::with_id(app, "clear", l("清空列表", "Clear List"), true, None::<&str>)?;
    let theme_i = MenuItem::with_id(
        app,
        "theme",
        l("切换深浅主题", "Toggle Theme"),
        true,
        None::<&str>,
    )?;
    let site_i = MenuItem::with_id(app, "website", l("官方网站", "Website"), true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        "Pic2WebP",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(l("关于 Pic2WebP", "About Pic2WebP")), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        l("文件", "File"),
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
        l("编辑", "Edit"),
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

    let view_menu = Submenu::with_items(app, l("显示", "View"), true, &[&theme_i])?;

    let window_menu = Submenu::with_items(
        app,
        l("窗口", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        l("帮助", "Help"),
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
