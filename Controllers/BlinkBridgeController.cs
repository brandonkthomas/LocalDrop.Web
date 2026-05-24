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
        ViewData["IsAppPage"] = true;

        return View("~/Apps/BlinkBridge/Views/Index.cshtml");
    }
}
