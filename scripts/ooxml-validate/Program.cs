// Prints the Open XML SDK validator's findings for each DOCX or PPTX path given as an
// argument, as one JSON object: { "<path>": [ { id, type, part, path, description } ] }.
// A file that cannot be opened as a package reports one finding with id "open".
// Exit status is 0 whenever it ran, whatever it found: judging the findings is
// the caller's job (a differential test, not a gate on absolute validity,
// because some fixtures are invalid in their original form on purpose).
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

var result = new SortedDictionary<string, List<Dictionary<string, string>>>(StringComparer.Ordinal);

foreach (var file in args)
{
    var findings = new List<Dictionary<string, string>>();
    try
    {
        // The package type follows the extension (a .pptx is a PresentationDocument).
        using OpenXmlPackage doc = file.EndsWith(".pptx", StringComparison.OrdinalIgnoreCase)
            ? PresentationDocument.Open(file, false)
            : WordprocessingDocument.Open(file, false);
        var validator = new OpenXmlValidator();
        foreach (var e in validator.Validate(doc))
        {
            findings.Add(new Dictionary<string, string>
            {
                ["id"] = e.Id ?? "",
                ["type"] = e.ErrorType.ToString(),
                ["part"] = e.Part?.Uri.ToString() ?? "",
                ["path"] = e.Path?.XPath ?? "",
                ["description"] = e.Description ?? "",
            });
        }
    }
    catch (Exception ex)
    {
        findings.Add(new Dictionary<string, string>
        {
            ["id"] = "open",
            ["type"] = "Package",
            ["part"] = "",
            ["path"] = "",
            ["description"] = ex.GetType().Name,
        });
    }
    result[file] = findings;
}

Console.WriteLine(JsonSerializer.Serialize(result));
