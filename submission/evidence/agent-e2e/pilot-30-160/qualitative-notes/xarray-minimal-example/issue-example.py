import xarray as xr

x_coord = xr.DataArray(
    [1, 2, 3],
    dims="x",
    attrs={"units": "m"}
)
a = xr.DataArray(
    [1, 2, 3],
    dims="x",
    coords={"x": x_coord},
    attrs={"units": "K"}
)
res = xr.where(a > 1, a, 0, keep_attrs=True)
assert res.coords["x"].attrs["units"] == "m"  # Fails, overridden with "K"
