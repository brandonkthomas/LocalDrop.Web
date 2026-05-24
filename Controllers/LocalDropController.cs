using Microsoft.AspNetCore.Mvc;

namespace LocalDrop.Web.Controllers;

/// <summary>
/// Controller for the LocalDrop client-side transfer tool.
/// </summary>
public class LocalDropController : Controller
{
    /// <summary>
    /// Display the LocalDrop app.
    /// </summary>
    [HttpGet("/localdrop")]
    public IActionResult Index()
    {
        ViewData["Title"] = "LocalDrop";
        ViewData["IsAppPage"] = true;

        return View("~/Apps/LocalDrop/Views/Index.cshtml");
    }
}
