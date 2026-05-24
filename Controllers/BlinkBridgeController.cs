using Microsoft.AspNetCore.Mvc;

namespace BlinkBridge.Web.Controllers;

/// <summary>
/// Controller for the BlinkBridge client-side transfer tool.
/// </summary>
public class BlinkBridgeController : Controller
{
    /// <summary>
    /// Display the BlinkBridge app.
    /// </summary>
    [HttpGet("/blinkbridge")]
    public IActionResult Index()
    {
        ViewData["Title"] = "BlinkBridge";
        ViewData["CanPinchToZoom"] = true;
        ViewData["IsolatedCss"] = true;
        ViewData["HideNavbar"] = true;
        ViewData["ShowLoadingOverlay"] = false;
        ViewData["ThemeColor"] = "#f4f5f7";
        ViewData["AppleMobileWebAppTitle"] = "BlinkBridge";
        ViewData["SuppressCdnPreconnect"] = true;

        return View("~/Apps/BlinkBridge/Views/Index.cshtml");
    }
}
